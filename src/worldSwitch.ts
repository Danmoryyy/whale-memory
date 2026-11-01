import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableWrite } from './files.ts';
import type { MemoryBounds } from './history.ts';

interface WorldSettings { running: boolean; dailyBudget?: number; memoryTurns?: number; memoryHours?: number; memoryChars?: number }
/** How many of the newest turns the memory block carries when nothing else is set. */
export const DEFAULT_MEMORY_TURNS = 200;
/** Hours back the memory block reaches when nothing else is set; the span a day is remembered over. */
export const DEFAULT_MEMORY_HOURS = 24;
/** Characters of message text the memory block carries when nothing else is set, so a dense day cannot grow it without limit. */
export const DEFAULT_MEMORY_CHARS = 40_000;

/**
 * Her world's own settings, changed from the world console and kept in `<world>/world.json` so they outlast a
 * restart: whether it runs (memory block, prompts, archive and life line together), how much her home may
 * spend a day, and how deep her memory block reaches. Depth is bounded three ways at once — the newest N turns,
 * the last N hours, and N characters of text — because a turn count alone makes the span unpredictable: the
 * denser the day, the shorter the reach, so the busiest day would be remembered worst. Whichever runs out first
 * ends the block. A world that already has a life line from before the switch existed is running; a new one
 * waits for its partner to press start.
 */
export function createWorldSwitch(worldDir: string) {
  const file = join(worldDir, 'world.json');
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<WorldSettings> : undefined;
  let settings: WorldSettings = {
    running: stored ? stored.running === true : existsSync(join(worldDir, 'life.json')),
    ...(typeof stored?.dailyBudget === 'number' ? { dailyBudget: stored.dailyBudget } : {}),
    ...(validTurns(stored?.memoryTurns) ? { memoryTurns: stored.memoryTurns } : {}),
    ...(validHours(stored?.memoryHours) ? { memoryHours: stored.memoryHours } : {}),
    ...(validChars(stored?.memoryChars) ? { memoryChars: stored.memoryChars } : {}),
  };
  function save(next: WorldSettings): void {
    durableWrite(file, JSON.stringify(next, null, 2));
    settings = next;
  }
  return {
    running: () => settings.running,
    set: (running: boolean) => save({ ...settings, running }),
    /** CNY a day for her home; undefined is no limit. */
    dailyBudget: () => settings.dailyBudget,
    setDailyBudget(yuan: number | undefined): void {
      const { dailyBudget: _old, ...rest } = settings;
      save(yuan === undefined ? rest : { ...rest, dailyBudget: yuan });
    },
    /** Turns in her memory block; read when a block is built, so a change shows from the next session start or compaction. */
    memoryTurns: () => settings.memoryTurns ?? DEFAULT_MEMORY_TURNS,
    setMemoryTurns(turns: number | undefined): void {
      const { memoryTurns: _old, ...rest } = settings;
      save(turns === undefined || turns === DEFAULT_MEMORY_TURNS ? rest : { ...rest, memoryTurns: turns });
    },
    /** How deep her memory block reaches; read when a block is built, like `memoryTurns`. */
    memoryBounds: (): MemoryBounds => ({
      turns: settings.memoryTurns ?? DEFAULT_MEMORY_TURNS,
      hours: settings.memoryHours ?? DEFAULT_MEMORY_HOURS,
      chars: settings.memoryChars ?? DEFAULT_MEMORY_CHARS,
    }),
    setMemoryBounds(bounds: Partial<MemoryBounds>): void {
      const { memoryTurns: _t, memoryHours: _h, memoryChars: _c, ...rest } = settings;
      const turns = bounds.turns ?? settings.memoryTurns; const hours = bounds.hours ?? settings.memoryHours; const chars = bounds.chars ?? settings.memoryChars;
      save({
        ...rest,
        ...(validTurns(turns) && turns !== DEFAULT_MEMORY_TURNS ? { memoryTurns: turns } : {}),
        ...(validHours(hours) && hours !== DEFAULT_MEMORY_HOURS ? { memoryHours: hours } : {}),
        ...(validChars(chars) && chars !== DEFAULT_MEMORY_CHARS ? { memoryChars: chars } : {}),
      });
    },
  };
}
export type WorldSwitch = ReturnType<typeof createWorldSwitch>;
export const validTurns = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
export const validHours = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
export const validChars = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
