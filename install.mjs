#!/usr/bin/env node
/**
 * whale-memory 一键安装器 — 第一版
 *
 * 目标人群：不会改 cordis.patch.yml 的普通 DSH 用户。
 * 一次跑完四步：查冲突 → 备份 → 改配置 → 提示重启。
 *
 * 设计原则（重要，改代码前先读）：
 *  1. 只按文本改写补丁层，绝不 parse→stringify 回写。DSH 的 cordis.patch.yml
 *     里有大量中文注释和 `insert:` 结构，任何一次 YAML 重序列化都会把它们
 *     一并吐掉。市场 dshmarket 自己也只用文本改写（见 lib/patch.js）。
 *  2. 查冲突必须在最前面，且默认拒绝。
 *     `dsh-world` 与 `whale-memory` 同时启用会在同一会话插两份记忆块，
 *     触发 "cannot locate retained injected context"；而 DSH 启动是全有全无，
 *     一个插件加载失败整个进程退出 —— 用户的整台 DSH 就没了。
 *  3. 写之前一定先备份，备份目录里放一份能一键还原的还原脚本。
 *  4. 不静默。装完必须显式告诉用户要重启。
 *
 * 用法：
 *   node install.mjs                    # 交互式安装（推荐）
 *   node install.mjs --dry-run          # 只报告，不写任何文件
 *   node install.mjs --yes              # 非交互，全部用默认答案
 *   node install.mjs --home D:\dsh-home-nahida
 *   node install.mjs --profile desktop
 *   node install.mjs --rollback <备份目录>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

// ─── 参数 ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DRY_RUN = flag('dry-run');
const ASSUME_YES = flag('yes');
const ROLLBACK_DIR = opt('rollback', null);
const PROFILE_NAME = opt('profile', process.env.DSH_PROFILE || 'desktop');

/** 与 DSH / dshmarket 同语义：显式 > DSH_HOME > ~/.dsh。空值视为未设置。 */
function resolveDshHome(configured) {
  const env = process.env.DSH_HOME;
  const raw = configured ?? (env && env.trim().length > 0 ? env : join(homedir(), '.dsh'));
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
    ? join(homedir(), raw.slice(2)) : raw;
  return resolve(expanded);
}

const DSH_HOME = resolveDshHome(opt('home', null));
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME);
const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml');
const MANIFEST_FILE = join(PROFILE_DIR, 'package.json');
const WORLD_DIR = join(DSH_HOME, 'worlds', 'default');
const WORLD_FILE = join(WORLD_DIR, 'world.json');

const OWN_ROW_ID = 'whale-memory';
const LEGACY_ROW_ID = 'dsh-world';
const OWN_PACKAGE = 'whale-memory';

// ─── 输出 ────────────────────────────────────────────────────────────────

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' }
  : { dim: '', bold: '', red: '', green: '', yellow: '', cyan: '', reset: '' };

const step = (n, text) => console.log(`\n${C.bold}[${n}/4]${C.reset} ${text}`);
const ok = (t) => console.log(`  ${C.green}✓${C.reset} ${t}`);
const warn = (t) => console.log(`  ${C.yellow}!${C.reset} ${t}`);
const bad = (t) => console.log(`  ${C.red}✗${C.reset} ${t}`);
const note = (t) => console.log(`  ${C.dim}${t}${C.reset}`);

function die(message, fix) {
  console.log(`\n${C.red}${C.bold}安装中止${C.reset}`);
  console.log(`  ${message}`);
  if (fix) console.log(`\n  ${fix}`);
  console.log('');
  process.exit(1);
}

// ─── 交互 ────────────────────────────────────────────────────────────────

let rl = null;
function ask(question, { options = null, defaultAnswer = '' } = {}) {
  if (ASSUME_YES) return defaultAnswer;
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = options
    ? `${question}\n${options.map((o, i) => `  ${i + 1}) ${o}`).join('\n')}\n  选择 [${defaultAnswer}]: `
    : `${question}${defaultAnswer ? ` [${defaultAnswer}]` : ''} `;
  return new Promise(res => rl.question(prompt, a => res(a.trim() === '' ? defaultAnswer : a.trim())));
}

// ─── 补丁层读取：只在文本层面看，不 parse ─────────────────────────────────

/**
 * 一行是否是某个 row id 的条目行（允许引号形式，允许缩进）。
 *
 * 必须容忍缩进：whale-memory 这类不在 profile bundles 里的插件只能写成
 * `- insert:` 下的子条目：
 *     - insert:
 *         - id: whale-memory
 *           name: whale-memory
 * 只认顶层的 `- id: X` 会看不见它，进而追加出第二份 —— 一个插件被加载两次，
 * 正是会把整台 DSH 弄崩的那种错误。
 *
 * 是条目行则返回该行的缩进宽度，否则返回 null。
 */
function rowIndent(line, rowId) {
  const bare = line.replace(/\r?\n$/, '');
  const esc = rowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^( *)- id: (?:${esc}|'${esc}'|"${esc}")[ \\t]*$`, 'u');
  const m = re.exec(bare);
  return m ? m[1].length : null;
}

/** 紧随条目行之后、属于这个条目的第一行内容（跳过空行与注释）的下标。 */
function nextContentIndex(lines, from) {
  let j = from;
  while (j < lines.length && (lines[j].trim() === '' || lines[j].trimStart().startsWith('#'))) j += 1;
  return j;
}

/**
 * 在补丁层文本里找某个 row 的最终生效状态。
 * 同 market 的 lastRowFlag：后出现的条目覆盖先出现的。
 * 返回 { present, disabled, count, indents }
 */
function rowState(text, rowId) {
  const lines = text.split(/\r?\n/u);
  let present = false, disabled = null, count = 0;
  const indents = [];
  for (let i = 0; i < lines.length; i += 1) {
    const indent = rowIndent(lines[i], rowId);
    if (indent === null) continue;
    present = true;
    count += 1;
    indents.push(indent);
    const j = nextContentIndex(lines, i + 1);
    const re = new RegExp(`^ {${indent + 2}}disabled: (true|false)[ \\t]*$`, 'u');
    const m = re.exec((lines[j] ?? '').replace(/\r?\n$/, ''));
    if (m) disabled = m[1] === 'true';
  }
  return { present, disabled, count, indents };
}

/**
 * 补丁层是否是一个合法的顶层条目数组。
 * 只用于校验：解析成功与否，绝不把解析结果写回去（那会丢掉全部注释）。
 * 找不到 YAML 库时退化成保守的文本判断，宁可拒绝也不写坏文件。
 */
async function looksLikeEntryList(text) {
  const meaningful = text.split(/\r?\n/u).map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'));
  if (meaningful.length === 0) return true;                 // 空文件 / 只有注释，可追加
  if (meaningful.length === 1 && /^\[[ \t]*\]$/u.test(meaningful[0])) return 'placeholder';

  const yaml = await tryLoadYaml();
  if (yaml) {
    try {
      const value = yaml.parse(text);
      return Array.isArray(value) ? true : false;
    } catch {
      return false;
    }
  }
  // 退路：条目列表的顶层每一段都以 `- ` 开头，其余行必须缩进。
  // 关键是不能把 `  name:` / `  config:` 这类缩进子键当成非法。
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^[ \t]/u.test(line)) continue;                     // 缩进行，属于上一条目
    if (!line.startsWith('- ')) return false;               // 顶格却不是条目 → 不是条目列表
  }
  return true;
}

/** 找一个可用的 YAML 解析器：先看 profile，再看安装器自己所在的目录。 */
async function tryLoadYaml() {
  const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const candidates = [
    join(PROFILE_DIR, 'node_modules', 'yaml', 'dist', 'index.js'),
    join(PROFILE_DIR, 'node_modules', 'js-yaml', 'index.js'),
    join(here, 'node_modules', 'yaml', 'dist', 'index.js'),
    join(here, 'node_modules', 'js-yaml', 'index.js'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const mod = await import(`file:///${p.replace(/\\/g, '/')}`);
      const lib = mod.default ?? mod;
      if (typeof lib.parse === 'function') return lib;
      if (typeof lib.load === 'function') return { parse: lib.load };
    } catch { /* 换下一个 */ }
  }
  return null;
}

// ─── 备份 ────────────────────────────────────────────────────────────────

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function makeBackup() {
  const dir = join(PROFILE_DIR, `whale-memory-backup-${stamp()}`);
  mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const [src, name] of [[PATCH_FILE, 'cordis.patch.yml'], [MANIFEST_FILE, 'package.json'], [WORLD_FILE, 'world.json']]) {
    if (existsSync(src)) {
      copyFileSync(src, join(dir, name));
      saved.push(name);
    }
  }
  writeFileSync(join(dir, 'restore.cmd'), [
    '@echo off',
    'REM 一键还原本次 whale-memory 安装前的配置',
    'REM 用法：双击，或在命令行执行 restore.cmd',
    'setlocal',
    `copy /Y "%~dp0cordis.patch.yml" "${PATCH_FILE}"`,
    `copy /Y "%~dp0package.json" "${MANIFEST_FILE}"`,
    existsSync(WORLD_FILE) ? `copy /Y "%~dp0world.json" "${WORLD_FILE}"` : 'REM world.json 原本不存在，未备份',
    'echo.',
    'echo 还原完成。请完全退出 DSH 再重新启动。',
    'pause',
  ].join('\r\n'), 'utf8');
  writeFileSync(join(dir, 'README.txt'), [
    'whale-memory 安装前备份',
    '',
    `时间：${new Date().toISOString()}`,
    `DSH_HOME：${DSH_HOME}`,
    `profile：${PROFILE_NAME}`,
    '',
    '包含：',
    ...saved.map(s => `  - ${s}`),
    '',
    '还原：运行本目录下的 restore.cmd，然后完全退出 DSH 再启动。',
    '或者手动把上面的文件拷回原位置：',
    `  ${PATCH_FILE}`,
    `  ${MANIFEST_FILE}`,
    `  ${WORLD_FILE}`,
  ].join('\r\n'), 'utf8');
  return { dir, saved };
}

// ─── 补丁层写入 ──────────────────────────────────────────────────────────

/**
 * 生成 whale-memory 的插入块（insert: 形式，因为插件不在 profile bundles 里）。
 *
 * 显式写 `disabled: false`：既表明安装器是「装上并启用」，也让重复运行
 * 得到逐字节相同的结果（否则第二次会给缺 disabled 行的条目补一行，两次产物不一致）。
 */
function ownInsertBlock() {
  return [
    '',
    '# whale-memory：由一键安装器写入。',
    '# 它与 dsh-world 绝不能同时启用 —— 同开会在同一会话插两份记忆块，',
    '# DSH 启动是全有全无，加载失败整个进程退出。',
    `- insert:`,
    `    - id: ${OWN_ROW_ID}`,
    `      name: ${OWN_PACKAGE}`,
    `      disabled: false`,
    '',
  ].join('\n');
}

/** 把 own 的 insert 块追加到补丁层末尾。 */
function appendOwnBlock(text) {
  const trimmed = text.replace(/^\uFEFF/u, '');
  const core = trimmed.trim();
  if (core === '') return ownInsertBlock().replace(/\n$/, '\n');
  // 模板自带的空数组占位符：注掉，保留头部注释
  const withoutComments = trimmed.replace(/^[ \t]*#.*$/gmu, '').trim();
  if (withoutComments === '') {
    return `${trimmed}${trimmed.endsWith('\n') ? '' : '\n'}${ownInsertBlock()}`;
  }
  if (withoutComments === '[]' || withoutComments === '[ ]') {
    const commented = trimmed.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n');
    return `${commented}${commented.endsWith('\n') ? '' : '\n'}${ownInsertBlock()}`;
  }
  return `${trimmed}${trimmed.endsWith('\n') ? '' : '\n'}${ownInsertBlock()}`;
}

/**
 * 模式 A 用的覆盖行：只有 `- id:` 和 `disabled: false`，**不带 insert**。
 *
 * insert 由插件包自己的补丁层提供（宿主施加）。这里再写一份 insert
 * 会让同一个 id 被插两次 —— 一个插件被加载两遍。
 */
function appendOverrideRow(text) {
  const trimmed = text.replace(/^\uFEFF/u, '');
  const core = trimmed.trim();
  const block = [
    '',
    '# whale-memory：由一键安装器写入。只覆盖这一行的开关，不重复 insert ——',
    '# insert 由插件自己的 cordis.patch.yml 提供。',
    '# 它与 dsh-world 绝不能同时启用，DSH 启动是全有全无。',
    `- id: ${OWN_ROW_ID}`,
    `  disabled: false`,
    '',
  ].join('\n');
  if (core === '') return block;
  const withoutComments = trimmed.replace(/^[ \t]*#.*$/gmu, '').trim();
  if (withoutComments === '') return `${trimmed}${trimmed.endsWith('\n') ? '' : '\n'}${block}`;
  if (withoutComments === '[]' || withoutComments === '[ ]') {
    const commented = trimmed.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n');
    return `${commented}${commented.endsWith('\n') ? '' : '\n'}${block}`;
  }
  return `${trimmed}${trimmed.endsWith('\n') ? '' : '\n'}${block}`;
}

/**
 * 在补丁层文本里把某个 row 的 disabled 改成指定值。
 *
 * 只碰该条目自己的那一行 disabled，其它每一行原文照抄。
 * 条目没有 disabled 行时补一行，位置在 id 行之后、与该条目的其它键同缩进。
 *
 * 块边界必须按「下一个同缩进的 `- ` 条目」算，**不能**按「缩进小于当前」算：
 * 形如
 *     - id: X
 *       name: X
 *       config:
 *         a: 1
 *     直到文件末尾都没有更小的缩进，按后者会把整个文件当成一个块，
 *     于是在块内找不到 disabled，也就改不到 X 自己那一行。
 */
function setRowDisabled(text, rowId, disabled) {
  const lines = text.split(/(?<=\n)/u); // 保留行尾
  let changed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const indent = rowIndent(lines[i], rowId);
    if (indent === null) continue;

    // 扫这一个条目的键块：到下一个「同缩进的 `- ` 条目」为止，或文件结束。
    let end = i + 1;
    while (end < lines.length) {
      const raw = lines[end].replace(/\r?\n/u, '');
      if (raw.trim() === '') { end += 1; continue; }
      const curIndent = raw.length - raw.trimStart().length;
      // 同缩进的另一个列表条目 → 本块结束
      if (curIndent === indent && /^- /u.test(raw.trimStart())) break;
      // 比本条目还浅的顶格内容 → 本块结束
      if (curIndent < indent) break;
      end += 1;
    }

    const keyRe = new RegExp(`^( +)disabled: (true|false)[ \\t]*(?:\\r?\\n)?$`, 'u');
    let flagIndex = -1;
    for (let j = i + 1; j < end; j += 1) {
      const m = keyRe.exec(lines[j].replace(/\r?\n$/, ''));
      if (m && m[1].length === indent + 2) { flagIndex = j; break; }
    }

    if (flagIndex >= 0) {
      const nl = lines[flagIndex].endsWith('\n') ? '\n' : '';
      lines[flagIndex] = `${' '.repeat(indent + 2)}disabled: ${disabled}${nl}`;
    } else {
      // 没有 disabled 行：插在 id 行之后、紧跟它的下一个同缩进键之前。
      let insertAt = i + 1;
      while (insertAt < end) {
        const raw = lines[insertAt].replace(/\r?\n/u, '');
        if (raw.trim() === '' || raw.trimStart().startsWith('#')) { insertAt += 1; continue; }
        const curIndent = raw.length - raw.trimStart().length;
        if (curIndent === indent + 2) break;
        insertAt += 1;
      }
      if (!lines[i].endsWith('\n')) lines[i] += '\n';
      lines.splice(insertAt, 0, `${' '.repeat(indent + 2)}disabled: ${disabled}\n`);
      i = insertAt;
    }
    changed += 1;
  }
  return { text: lines.join(''), hits: changed };
}

// ─── 主体 ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.cyan}${C.bold}whale-memory 一键安装器${C.reset}`);
  console.log(`${C.dim}给 DSH 的陪伴角色一条会记得昨天的记忆线。${C.reset}`);
  console.log(`\n${C.dim}DSH_HOME：${DSH_HOME}${C.reset}`);
  console.log(`${C.dim}profile ：${PROFILE_NAME}${C.reset}`);
  if (DRY_RUN) console.log(`${C.yellow}（演练模式：只看不写）${C.reset}`);

  if (ROLLBACK_DIR) return rollback(ROLLBACK_DIR);

  // ── 0. 前置检查 ─────────────────────────────────────────────────────
  if (!existsSync(PROFILE_DIR)) {
    die(`找不到 profile 目录：${PROFILE_DIR}`, '先启动一次 DSH，或指定正确的 --home / --profile。');
  }
  if (!existsSync(PATCH_FILE)) {
    die(`找不到补丁层文件：${PATCH_FILE}`, '这个 profile 不是标准的 DSH 配置，安装器不认识它的布局。');
  }

  /**
   * 包本身在不在？这一条放在**最前面**，因为它比冲突检查更致命。
   *
   * 安装器只改配置、不装代码。如果 profile 里没有这个包，写进去的
   * `- id: whale-memory` / `name: whale-memory` 会让加载器找不到模块，
   * DSH 启动是**全有全无**，一个插件加载失败整个进程就退出 ——
   * 用户装完打不开 DSH，比装不上更糟。
   *
   * 这个坑是纳西妲第 27 封回信里差点踩到的：她那台机器上根本没有这个包，
   * 却已经回「可以装」。如果安装器不自己挡下来，就要在人家的机器上炸一次。
   */
  const packageDir = join(PROFILE_DIR, 'node_modules', OWN_PACKAGE);
  const packageEntry = join(packageDir, 'lib', 'index.js');
  if (!existsSync(packageEntry)) {
    die(`这个 profile 里没有 ${OWN_PACKAGE} 这个包：${packageEntry} 不存在`,
      [
        '安装器只改配置、不装代码，所以包必须先在（否则 DSH 启动会因找不到模块而整个退出）。',
        '装包：',
        `  cd "${PROFILE_DIR}"`,
        `  pnpm add ${OWN_PACKAGE}                 # 从 registry 装（发布后）`,
        `  pnpm add <whale-memory-0.1.0.tgz>       # 或装本地 tarball`,
        '',
        '装好之后重跑本安装器。现在什么都没改。',
      ].join('\n'));
  }
  ok(`${OWN_PACKAGE} 包已就位`);

  // ── 1. 查冲突 ───────────────────────────────────────────────────────
  step(1, '查冲突');
  const patchText = readFileSync(PATCH_FILE, 'utf8');
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')); } catch { /* 下面单独报 */ }
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };

  const legacy = rowState(patchText, LEGACY_ROW_ID);
  const legacyInstalled = Object.hasOwn(deps, LEGACY_ROW_ID);

  /**
   * whale-memory 这一行是从哪儿来的？两种可能，处理方式完全不同：
   *
   *  A. 插件**同时**在 `dsh.profile.bundles` 里，并且声明了 `dsh.bundle.patch` ——
   *     宿主会施加它自带的 `cordis.patch.yml`，insert 行已经在了。这时 profile
   *     里**不能再写 insert**，否则同一个 id 被插两次。只能写「覆盖行」
   *     （不带 insert 的 `- id:` + disabled）来决定开还是关。
   *  B. 否则（包只是躺在 node_modules、没进 bundles）——没人施加它自带的补丁，
   *     必须由安装器写 `- insert:` 才能把它拉起来。
   *
   * 判据必须是**两个条件同时成立**。只看「包有没有声明 bundle.patch」是不够的：
   * `pnpm add` 只往 dependencies 里写一行，**不会**把包塞进
   * `dsh.profile.bundles`（bundles 由 dsh plugin 命令调和，见 dshmarket
   * lib/order.js 的 `manifest.dsh.profile.bundles = merged.bundles`）。
   * 只按声明判断，会对一个根本没被宿主加载的包写覆盖行 —— 结果是装上后静默无效，
   * 用户以为装了其实没起作用。我们这台机器早期就正是这种状态：包在 node_modules，
   * 从不在 bundles，靠手写 insert 才跑起来的。
   */
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter(x => typeof x === 'string')
    : [];
  const inBundles = bundles.includes(OWN_PACKAGE);

  const pkgDir = join(PROFILE_DIR, 'node_modules', OWN_PACKAGE);
  let declaresPatch = false;
  try {
    const pkgManifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const declared = pkgManifest.dsh?.bundle?.patch;
    const list = typeof declared === 'string' ? [declared]
      : Array.isArray(declared) ? declared.filter(x => typeof x === 'string') : [];
    declaresPatch = list.length > 0 && list.every(rel => existsSync(join(pkgDir, rel)));
  } catch { /* 包还没装进 profile */ }

  const selfBundled = inBundles && declaresPatch;

  note(`插件在 bundles 里：${inBundles ? '是' : '否'}；声明了可用的 bundle 补丁：${declaresPatch ? '是' : '否'}`);
  if (!selfBundled) note('→ 由安装器自己写 insert 行（宿主不会施加它的补丁）');
  else note('→ 宿主会施加它的 insert 行，这里只写开关覆盖行');

  // 补丁层能读懂吗？读不懂就先停下，绝不在坏文件上再写一笔
  const shape = await looksLikeEntryList(patchText);
  if (shape === false) {
    die('补丁层不是合法的条目列表，已拒绝写入',
      `文件：${PATCH_FILE}\n  多半是手工编辑过、多了一个顶层元素。请先修正 YAML 再重跑安装器。`);
  }
  ok('补丁层结构可读');

  note(`dsh-world 已安装：${legacyInstalled ? '是' : '否'}；补丁层里 ${legacy.present ? `有该行（disabled=${legacy.disabled}）` : '没有该行'}`);

  /**
   * 判定 dsh-world「是否正在运行」，必须按「没写 disabled 就是启用」算。
   *
   * `disabled=null` 表示这一行没有 disabled 字段 —— 默认启用，**不是**没冲突。
   * 只判 `disabled === false` 会把它当成安全放过去（实测纳西妲机器上就是这个形态：
   * 她那行 `- id: dsh-world` 只写了 name 和 config，没有 disabled）。
   * 放过去的结果是安装器一声不响把两个记忆插件都打开，DSH 起不来。
   */
  const legacyRunning = legacy.present && legacy.disabled !== true;

  if (legacyRunning) {
    bad('dsh-world 正启用着，whale-memory 不能同时上');
    note('两个记忆插件同开，一次请求会插两份记忆块，DSH 会直接起不来。');
    note(`（判定依据：补丁层里 ${legacy.present
      ? (legacy.disabled === null ? '有该行且没写 disabled —— 默认就是启用' : 'disabled 不是 true')
      : '没有该行'}）`);
    if (!DRY_RUN) {
      const choice = await ask('怎么处理？', {
        options: ['安装 whale-memory，同时停用 dsh-world（推荐）', '不装了，退出'],
        defaultAnswer: '1',
      });
      if (choice === '2') die('用户选择退出', '什么都没改，你的配置原样不动。');
      ok('将停用 dsh-world');
    }
  } else if (legacyInstalled && legacy.disabled === true && !legacy.present) {
    warn('dsh-world 装着但补丁层没有它的行，会按默认启用');
    note('安装器会补一条停用行，比让它和 whale-memory 撞车安全。');
  } else if (legacyInstalled) {
    warn('dsh-world 装着，补丁层里已标为停用');
    note('安装器会另写一条 disabled: true 确认它真的停着。');
  } else {
    ok('没有冲突的旧记忆插件');
  }

  // ── 2. 备份 ─────────────────────────────────────────────────────────
  step(2, '备份');
  if (DRY_RUN) {
    note(`将会备份到：${join(PROFILE_DIR, 'whale-memory-backup-<时间戳>/')}`);
    note('包含 cordis.patch.yml、package.json、world.json，外加 restore.cmd');
  } else {
    const { dir, saved } = makeBackup();
    ok(`已备份 ${saved.length} 个文件`);
    note(dir);
  }

  // ── 3. 改配置 ───────────────────────────────────────────────────────
  step(3, '改配置');
  let nextPatch = patchText;
  const own = rowState(patchText, OWN_ROW_ID);

  if (selfBundled) {
    // 模式 A：包自带补丁行，宿主会施加。profile 只写覆盖行（不带 insert）。
    note('插件包自带补丁层（dsh.bundle.patch），由宿主施加它的 insert 行');
    if (own.present) {
      const r = setRowDisabled(nextPatch, OWN_ROW_ID, false);
      nextPatch = r.text;
      if (r.hits > 0) ok('profile 覆盖行：whale-memory 启用');
      else warn('whale-memory 行存在但没有 disabled 字段，视为已启用');
    } else {
      nextPatch = appendOverrideRow(nextPatch);
      ok('已写入 profile 覆盖行（启用，不重复 insert）');
    }
  } else if (own.present) {
    // 模式 B：包在 node_modules 里但没人施加它的补丁 —— 或补丁层已有我们的行
    const r = setRowDisabled(nextPatch, OWN_ROW_ID, false);
    nextPatch = r.text;
    if (r.hits > 0) ok('whale-memory 已在补丁层，改为启用');
    else warn('whale-memory 行存在但没有 disabled 字段，视为已启用');
  } else {
    nextPatch = appendOwnBlock(nextPatch);
    ok('已写入 whale-memory 条目（insert 形式）');
  }

  if (legacy.present) {
    const r = setRowDisabled(nextPatch, LEGACY_ROW_ID, true);
    nextPatch = r.text;
    if (r.hits > 0) ok('已停用 dsh-world');
    else warn('dsh-world 行没有 disabled 字段，未能就地改写');
  }

  // world.json：running 必须 false（whale-memory 不看它，但 dsh-world 看）
  let world = { running: false, memoryTurns: 30 };
  if (existsSync(WORLD_FILE)) {
    try { world = { ...JSON.parse(readFileSync(WORLD_FILE, 'utf8')), running: false, memoryTurns: 30 }; }
    catch { note('world.json 读不出来，将写一份新的'); }
  }
  ok(`world.json → running: false, memoryTurns: 30`);

  if (DRY_RUN) {
    console.log(`\n${C.dim}── 演练：补丁层将会变成这样（只显示 diff 行）──${C.reset}`);
    const before = patchText.split('\n'), after = nextPatch.split('\n');
    for (const l of after) if (!before.includes(l)) console.log(`  ${C.green}+${l}${C.reset}`);
    for (const l of before) if (!after.includes(l)) console.log(`  ${C.red}-${l}${C.reset}`);
    console.log(`\n${C.yellow}演练结束，没有写任何文件。${C.reset}\n`);
    return;
  }

  writeFileSync(PATCH_FILE, nextPatch, 'utf8');
  ok('补丁层已写入');
  mkdirSync(WORLD_DIR, { recursive: true });
  writeFileSync(WORLD_FILE, JSON.stringify(world, null, 2), 'utf8');
  ok('world.json 已写入');

  // ── 4. 提示重启 ─────────────────────────────────────────────────────
  step(4, '提示重启');
  console.log(`\n${C.yellow}${C.bold}还差最后一步：完全退出 DSH，再重新启动。${C.reset}`);
  console.log('  配置改动不会热生效，不重启的话新记忆线不会起来。');
  console.log(`\n${C.dim}如果重启后 DSH 打不开：运行刚才那份备份里的 restore.cmd，${C.reset}`);
  console.log(`${C.dim}它会把这几个文件原样拷回去。备份在这：${C.reset}`);
  console.log(`  ${C.dim}${join(PROFILE_DIR, 'whale-memory-backup-*')}${C.reset}\n`);
  if (rl) rl.close();
}

function rollback(dir) {
  const abs = resolve(dir);
  if (!existsSync(abs)) die(`找不到备份目录：${abs}`);
  const files = ['cordis.patch.yml', 'package.json', 'world.json'];
  for (const name of files) {
    const src = join(abs, name);
    if (!existsSync(src)) continue;
    const dest = name === 'cordis.patch.yml' ? PATCH_FILE : name === 'package.json' ? MANIFEST_FILE : WORLD_FILE;
    if (DRY_RUN) { note(`将会还原 ${name} → ${dest}`); continue; }
    copyFileSync(src, dest);
    ok(`已还原 ${name}`);
  }
  if (DRY_RUN) return;
  console.log(`\n${C.yellow}还原完成。请完全退出 DSH 再重新启动。${C.reset}\n`);
}

main().catch(err => { die(`未预期的错误：${err?.message ?? err}`, String(err?.stack ?? '')); });
