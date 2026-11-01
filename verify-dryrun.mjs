// Read-only rehearsal against a real archive: load the recent turns and render the memory block
// a session would open with. Nothing is written, nothing is injected.
//
//   node verify-dryrun.mjs                          # uses DSH_HOME / ~/.dsh, world "default"
//   node verify-dryrun.mjs --home D:\dsh-home --world default --turns 30
//   node verify-dryrun.mjs --home ~/.dsh --names 小鱼 我
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createArchiveStore } from './lib/store.js';
import { createHistory, renderHistory } from './lib/history.js';
import { worldNames } from './lib/worldPrompt.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

function resolveDshHome(configured) {
  const env = process.env.DSH_HOME;
  const raw = configured ?? (env && env.trim() ? env : join(homedir(), '.dsh'));
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') ? join(homedir(), raw.slice(2)) : raw;
  return resolve(expanded);
}

const root = resolveDshHome(opt('home', null));
const worldId = opt('world', 'default');
const turnsWanted = Number(opt('turns', 30));
const [companion, partner] = opt('names', 'TA 伙伴').split(/\s+/);
const timeZone = opt('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

const worldDir = join(root, 'worlds', worldId);
if (!existsSync(worldDir)) {
  console.error(`No world directory at ${worldDir}`);
  console.error('Pass --home <your DSH home> (or set DSH_HOME) and --world <worldId>.');
  process.exit(1);
}

const worldJson = join(worldDir, 'world.json');
const bounds = {
  ...(Number.isFinite(turnsWanted) ? { turns: turnsWanted } : {}),
  ...(existsSync(worldJson)
    ? (() => { try { const w = JSON.parse(readFileSync(worldJson, 'utf8')); return typeof w.memoryTurns === 'number' ? { turns: w.memoryTurns } : {}; } catch { return {}; } })()
    : {}),
};

const store = createArchiveStore({ worldId, agentPreset: opt('preset', 'standard'), timeZone, root });
const history = createHistory(store);
const names = worldNames({ companionName: companion, partnerName: partner });

const stateFile = opt('state', join(worldDir, 'state.md'));
const state = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '';

const turns = await history.loadRecentTurns(worldId, bounds);
const text = renderHistory(turns, timeZone, names, false, state);

console.log(`home      : ${root}`);
console.log(`world     : ${worldId}`);
console.log(`time zone : ${timeZone}`);
console.log(`turns     : ${turns.length} (requested ${bounds.turns})`);
console.log(`rendered  : ${text.length} chars, ${Buffer.byteLength(text, 'utf8')} bytes`);
console.log(`archive   : ${store.stats().records} records, ${store.stats().sessions} sessions`);
console.log('');
console.log('--- first 3 lines ---');
console.log(text.split('\n').slice(0, 3).join('\n'));
console.log('');
console.log('--- newest turn (first 400 chars) ---');
const newest = text.split('\n').filter(l => l.startsWith('{"session"')).at(-1);
console.log(newest ? newest.slice(0, 400) : '(none)');
store.close();
