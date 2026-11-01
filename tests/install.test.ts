/**
 * install.mjs 的回归测试。
 *
 * 两个模式都要覆盖，它们在真实机器上对应两种完全不同的安装形态：
 *
 *   A. 插件作为 bundle 装进 profile：它自带的 cordis.patch.yml 由宿主施加，
 *      profile 里再写一份 insert 会让同一个 id 被插两次 → 只能写覆盖行。
 *   B. 插件包只是躺在 node_modules 里（手动拷的）：没人施加它的补丁，
 *      profile 必须写 insert 才拉得起来。
 *
 * 每个用例都在临时目录里造一份 home，**绝不碰真实 DSH home**。
 * 造不出真实 profile 时整组跳过（不假装通过）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const installer = join(pkgRoot, 'install.mjs');

/** 一个最小的 profile：空补丁层 + 一份 package.json。 */
function makeHome(
  name: string,
  {
    withBundle = false,
    withPackage = true,
    memoryTurns = 20,
    running = true,
  }: { withBundle?: boolean; withPackage?: boolean; memoryTurns?: number; running?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), `wm-install-${name}-`));
  const profDir = join(root, 'profiles', 'desktop');
  mkdirSync(profDir, { recursive: true });

  // DSH 的 profile 模板：头部注释 + 空数组占位符
  writeFileSync(join(profDir, 'cordis.patch.yml'), [
    '# dsh profile root — an empty entry list. Edit cordis.patch.yml, not this file.',
    '[]',
  ].join('\n'), 'utf8');

  // withBundle 表示包**同时**进了 dsh.profile.bundles（市场/dsh plugin add 的真实形态）；
  // 只 `pnpm add` 的话依赖有了、bundles 里没有，那种情况走模式 B。
  const manifest: Record<string, unknown> = { name: 'dsh-profile-test', dependencies: {} };
  if (withPackage) manifest.dependencies = { 'whale-memory': '*' };
  if (withBundle) manifest.dsh = { profile: { bundles: ['whale-memory'] } };
  writeFileSync(join(profDir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const worldDir = join(root, 'worlds', 'default');
  mkdirSync(worldDir, { recursive: true });
  writeFileSync(join(worldDir, 'world.json'), JSON.stringify({ running, memoryTurns }, null, 2), 'utf8');

  // 包本体必须落进 node_modules —— 安装器只改配置、不装代码，
  // 没有它就会拒绝（DSH 启动全有全无，找不到模块整个进程退出）。
  if (withPackage) {
    const pkgDir = join(profDir, 'node_modules', 'whale-memory');
    mkdirSync(join(pkgDir, 'lib'), { recursive: true });
    cpSync(join(pkgRoot, 'package.json'), join(pkgDir, 'package.json'));
    cpSync(join(pkgRoot, 'cordis.patch.yml'), join(pkgDir, 'cordis.patch.yml'));
    // 只需存在一个入口文件，安装器只判在不在，不会 import 它
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'export const name = "whale-memory";\n', 'utf8');
  }
  return root;
}

function run(home: string, extra: string[] = []): string {
  return execFileSync(process.execPath, [installer, '--home', home, '--yes', ...extra], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const patchOf = (home: string): string => readFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
const worldOf = (home: string): { memoryTurns?: number; running?: boolean } =>
  JSON.parse(readFileSync(join(home, 'worlds', 'default', 'world.json'), 'utf8'));

/** 数补丁层里 `- id: X` 出现几次（含 insert 下的子条目）。 */
function countRow(text: string, id: string): number {
  return (text.match(new RegExp(`^\\s*- id: ${id}\\s*$`, 'gmu')) ?? []).length;
}

test('模式 B：包在 node_modules 但没人施加它的补丁时，安装器写 insert', t => {
  const home = makeHome('modeB');
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const before = patchOf(home);
  run(home);
  const after = patchOf(home);

  assert.ok(after.includes('- insert:'), '应写 insert 块');
  assert.ok(after.includes('- id: whale-memory'), '应有 whale-memory 行');
  assert.equal(worldOf(home).memoryTurns, 30, 'world.json 应配到 30 轮');
  assert.equal(worldOf(home).running, false, 'running 应写 false');
  assert.equal(countRow(after, 'whale-memory'), 1, 'whale-memory 只能出现一次');
});

test('包根本不在时必须拒绝，一个字节都不写', t => {
  // 这是纳西妲第 27 封差点踩到的那种机器：她回「可以装」，但 profile 里
  // 根本没有这个包。安装器只改配置不装代码 —— 写进去会让加载器找不到模块，
  // DSH 启动全有全无，整个进程退出。必须在最前面挡住。
  const home = makeHome('nopkg', { withPackage: false });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const beforePatch = patchOf(home);
  const beforeWorld = JSON.stringify(worldOf(home));

  assert.throws(() => run(home), '包不在时应拒绝');
  assert.equal(patchOf(home), beforePatch, '补丁层不能被改');
  assert.equal(JSON.stringify(worldOf(home)), beforeWorld, 'world.json 不能被改');
});

test('模式 A：包自带 dsh.bundle.patch 时，只写覆盖行，绝不重复 insert', t => {
  const home = makeHome('modeA', { withBundle: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));

  run(home);
  const after = patchOf(home);

  assert.equal((after.match(/- insert:/g) ?? []).length, 0, 'profile 里不该再出现 insert');
  assert.ok(after.includes('- id: whale-memory'), '应写覆盖行');
  assert.equal(countRow(after, 'whale-memory'), 1);
});

test('重复运行必须幂等（两种模式）', t => {
  for (const mode of ['modeB', 'modeA']) {
    const home = makeHome(mode, { withBundle: mode === 'modeA' });
    t.after(() => rmSync(home, { recursive: true, force: true }));
    run(home);
    const first = patchOf(home);
    run(home);
    const second = patchOf(home);
    assert.equal(first, second, `${mode}: 两次运行结果应完全相同`);
    assert.equal(countRow(second, 'whale-memory'), 1, `${mode}: 不能出现第二条`);
  }
});

test('回滚能把补丁层与 world.json 还原到安装前', t => {
  const home = makeHome('rollback');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const beforePatch = patchOf(home);
  const beforeWorld = JSON.stringify(worldOf(home));

  run(home);
  const backup = execFileSync(process.execPath, ['-e',
    `console.log(require('fs').readdirSync(${JSON.stringify(join(home, 'profiles', 'desktop'))}).filter(n=>n.startsWith('whale-memory-backup'))[0]??'')`],
  { encoding: 'utf8' }).trim();
  assert.ok(backup !== '', '应生成备份目录');

  run(home, ['--rollback', join(home, 'profiles', 'desktop', backup)]);
  assert.equal(patchOf(home), beforePatch, '补丁层应还原');
  assert.equal(JSON.stringify(worldOf(home)), beforeWorld, 'world.json 应还原');
});

test('补丁层坏掉时拒绝写入，一个字节都不动', t => {
  const home = makeHome('broken');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const p = join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  writeFileSync(p, 'just a string, not a list\n', 'utf8');
  const before = patchOf(home);

  assert.throws(() => run(home), '应拒绝写入');
  assert.equal(patchOf(home), before, '原文件不能被改');
});

test('--dry-run 不写任何文件、不生成备份', t => {
  const home = makeHome('dry', { withBundle: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const beforePatch = patchOf(home);
  const beforeWorld = JSON.stringify(worldOf(home));

  try { run(home, ['--dry-run']); } catch { /* 允许非零退出 */ }

  assert.equal(patchOf(home), beforePatch, '补丁层不能变');
  assert.equal(JSON.stringify(worldOf(home)), beforeWorld, 'world.json 不能变');
  const backups = execFileSync(process.execPath, ['-e',
    `console.log(require('fs').readdirSync(${JSON.stringify(join(home, 'profiles', 'desktop'))}).filter(n=>n.startsWith('whale-memory-backup')).length)`],
  { encoding: 'utf8' }).trim();
  assert.equal(backups, '0', '不该生成备份');
});
