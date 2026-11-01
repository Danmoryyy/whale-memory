import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { errorText, Faults } from './faults.ts';
import { readPersona } from './persona.ts';
import { createWorldRuntime } from './runtime.ts';
import { createArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { worldNames } from './worldPrompt.ts';
import { createWorldSwitch } from './worldSwitch.ts';

export { createWorldRuntime } from './runtime.ts';
export type { WorldConfig, ConversationRecord, ConversationTurn, ArchiveCursor } from './types.ts';
export const name = 'whale-memory';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm'];

/**
 * What `apply` receives. Everything the old dsh-world needed for its console, life line, bridge and outlets is
 * gone: this is the memory line alone, so there is no switch to press and no stop button that can take her
 * persona away.
 */
export type Config = WorldConfig;
const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const Config = z.object({
  worldId: z.string().default('default'),
  agentPreset: z.string().default('standard'),
  timeZone: z.string().default(systemTimeZone),
  companionName: z.string(),
  partnerName: z.string(),
  archiveScope: z.union([z.const('world'), z.const('home')]).default('world'),
  selfFile: z.string().default(''),
  stateFile: z.string().default(''),
  worldPromptFile: z.string().default(''),
  personaFile: z.string().default(''),
  /** Rehearsal mode: read the existing archive and report the block a session would open with; import nothing. */
  dryRun: z.boolean().default(false),
});

/**
 * Her memory line. Cross-session recall and her persona are always on: there is no world switch, so a restart
 * brings her back with the same self. The archive lives in `<dsh-home>/worlds/<worldId>/`, so the existing
 * archive.sqlite and conversations/ are read as they are and no history is lost.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const dshHome = resolveDshHome();
  const worldDir = join(dshHome, 'worlds', config.worldId);
  const store = createArchiveStore({ ...config, root: dshHome });
  const power = createWorldSwitch(worldDir);
  const faults = new Faults();
  /** Her self-description lives in her room; she writes it with her file tools. */
  const selfFile = config.selfFile || join(worldDir, 'room', '我是谁.md');
  // Where she stopped: three short lines she overwrites, read into every memory block.
  const stateFile = config.stateFile || join(worldDir, 'state.md');
  const personaFile = config.personaFile || join(worldDir, 'persona.md');
  const worldPromptFile = config.worldPromptFile || join(worldDir, 'world-prompt.md');
  /** The name in her persona comes first, then the configured one. */
  const names = () => worldNames({ ...config, companionName: readPersona(personaFile).名字 || config.companionName });
  const prompt = { file: worldPromptFile, persona: personaFile, conversationsDir: join(worldDir, 'conversations'), stateFile, names: names() };
  const memory = createWorldRuntime(ctx, { ...config, selfFile }, store, { prompt, isHome: () => false }, power.memoryBounds, stateFile);

  ctx.effect(() => () => memory.stop().finally(() => store.close()), 'whale-memory');

  if (config.dryRun) {
    ctx.logger.info('whale-memory: DRY RUN — nothing is archived and nothing is injected');
    await memory.preview().then(text => {
      const lines = text ? text.split('\n').length : 0;
      ctx.logger.info(`whale-memory: a session would open with ${lines} lines of memory:`);
      ctx.logger.info(text || '(no archived turns yet)');
    }).catch(error => {
      ctx.logger.error(`whale-memory: preview failed: ${errorText(error)}`);
    });
    return;
  }

  try {
    await memory.start();
  } catch (error) {
    faults.set('memory', `记忆线没能启动：${errorText(error)}`);
    ctx.logger.error(error);
    throw error;
  }
  ctx.logger.info(`whale-memory: running for world "${config.worldId}" (persona ${existsSync(selfFile) ? 'present' : 'missing'}, template ${existsSync(worldPromptFile) ? 'custom' : 'shipped'})`);
}
