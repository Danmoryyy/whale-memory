import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchiveStore } from '../src/store.ts';
import { createHistory, renderHistory } from '../src/history.ts';
import { renderState, STATE_CAP } from '../src/state.ts';
import { record } from './fixtures.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whale-memory-bounds-'));
  const store = createArchiveStore({ root, worldId: 'fish', agentPreset: 'companion', timeZone: 'UTC' });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, history: createHistory(store) };
}

/** One turn per entry, one hour apart, newest at `base` plus `count` hours. */
function hourly(count: number, base = Date.UTC(2026, 9, 1)) {
  return Array.from({ length: count }, (_, i) => record(`r${i}`, {
    turnId: `t:${i}`,
    occurredAt: new Date(base + i * 3_600_000).toISOString(),
    content: `第${i}轮`,
  }));
}

test('a turn count alone still caps the block, newest first', async t => {
  const { store, history } = await setup(t);
  await store.commitRecords(hourly(50));
  const turns = await history.loadRecentTurns('fish', { turns: 10 });
  assert.equal(turns.length, 10);
  assert.equal(turns[0].turnId, 't:49'); assert.equal(turns[9].turnId, 't:40');
});

test('the hour window stops the block even when the turn budget is far from full', async t => {
  const { store, history } = await setup(t);
  await store.commitRecords(hourly(50));
  const turns = await history.loadRecentTurns('fish', { turns: 200, hours: 5 });
  // Newest at +49h; five hours back reaches +44h, so 49..44 = six turns including both ends.
  assert.equal(turns.length, 6);
  assert.equal(turns[0].turnId, 't:49'); assert.equal(turns.at(-1)!.turnId, 't:44');
  assert.ok(Date.parse(turns[0]!.occurredAt) - Date.parse(turns.at(-1)!.occurredAt) <= 5 * 3_600_000);
});

test('the character budget stops a dense stretch that would otherwise be huge', async t => {
  const { store, history } = await setup(t);
  await store.commitRecords(Array.from({ length: 30 }, (_, i) => record(`d${i}`, {
    turnId: `dense:${i}`, occurredAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(), content: 'x'.repeat(1000),
  })));
  const turns = await history.loadRecentTurns('fish', { turns: 200, chars: 5000 });
  assert.equal(turns.length, 5, 'five 1000-char turns fit, the sixth would exceed');
  assert.equal(turns[0].turnId, 'dense:29');
});

test('the newest turn is kept even when it alone exceeds every budget, so the block is never empty', async t => {
  const { store, history } = await setup(t);
  await store.commitRecords([record('huge', { turnId: 'huge', content: 'y'.repeat(50_000) })]);
  const turns = await history.loadRecentTurns('fish', { turns: 200, hours: 1, chars: 100 });
  assert.equal(turns.length, 1); assert.equal(turns[0].turnId, 'huge');
});

test('whichever bound runs out first wins, and the result is stable across repeated reads', async t => {
  const { store, history } = await setup(t);
  await store.commitRecords(hourly(300));
  const bounds = { turns: 40, hours: 10, chars: 100_000 };
  const first = await history.loadRecentTurns('fish', bounds);
  assert.equal(first.length, 11, 'ten hours back from +299h reaches +289h, so 11 turns');
  assert.deepEqual(await history.loadRecentTurns('fish', bounds), first);
  const capped = await history.loadRecentTurns('fish', { turns: 40, hours: 1000, chars: 100_000 });
  assert.equal(capped.length, 40);
});

test('renderHistory puts where she stopped above the conversation', () => {
  const turns = [{ turnId: 't', occurredAt: '2026-10-23T00:00:00.000Z', messages: [record('m', { content: '聊了点事' })] }];
  const names = { companion: '大肥鱼', partner: '骑士' };
  const state = '<停在哪>\n## 正在做\n改记忆\n</停在哪>';
  const text = renderHistory(turns, 'UTC', names, false, state);
  assert.ok(text.startsWith('<停在哪>\n## 正在做\n改记忆\n</停在哪>\n\n'), text.slice(0, 60));
  assert.ok(text.includes('聊了点事'));
  assert.ok(!renderHistory(turns, 'UTC', names, false, '').includes('停在哪'), 'no state, no heading');
  assert.equal(renderHistory([], 'UTC', names, false, state), `${state}\n\n（还没有聊天记录。）`);
  assert.equal(renderHistory([], 'UTC', names, false, ''), '', 'still silent when neither exists');
});

test('renderState reads her file, caps it, and speaks up when it cannot read it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.md');
  assert.equal(renderState(file), '', 'no file yet is simply nothing to say');
  writeFileSync(file, '## 正在做\n写测试\n');
  assert.equal(renderState(file), '<停在哪>\n## 正在做\n写测试\n</停在哪>');
  writeFileSync(file, 'z'.repeat(STATE_CAP + 50));
  const capped = renderState(file);
  assert.ok(capped.includes('后面还有 50 字没读进来'), capped.slice(-80));
  assert.ok(capped.length < STATE_CAP + 200);
  // A directory that exists but cannot be read as a file: the state must say so, not vanish.
  assert.ok(renderState(dir).startsWith('（这次没能读到'));
});
