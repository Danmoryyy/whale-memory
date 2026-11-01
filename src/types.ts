import type { SessionHeader } from '@deepseek-ai/dsh-session';

export interface WorldConfig {
  worldId: string;
  agentPreset: string;
  timeZone: string;
  /** Which conversations are archived (and so remembered): every world session (default), or her home only. The memory block goes to every world session either way. */
  archiveScope?: 'world' | 'home';
  /** The life line (home session, alarm, tools, console); on by default. */
  life?: boolean;
  /** Her diary directory; defaults to `<world>/diary`. */
  diaryDir?: string;
  /** Local HH:MM of the morning wake when no alarm is pending (she set none, or cancelled hers); 09:00 by default. */
  fallbackWakeTime?: string;
  /** Her own "who I am" file, part of the world prompt; defaults to `<world>/room/我是谁.md` in the plugin. */
  selfFile?: string;
  /** Where she writes what she was doing, what blocked her and what comes next; defaults to `<world>/state.md`. */
  stateFile?: string;
  /** Her name (home title, notifications, memory labels); TA when unset. */
  companionName?: string;
  /** What she calls her partner in the plugin's own words; 伙伴 when unset. */
  partnerName?: string;
  /** Her layered persona, edited in the world console; defaults to `<world>/persona.md`. */
  personaFile?: string;
  /** The world prompt template; defaults to `<world>/world-prompt.md` when it exists, else the shipped one. */
  worldPromptFile?: string;
  /** Rehearsal mode: read the existing archive and report the block a session would open with; import nothing. */
  dryRun?: boolean;
}
export interface ConversationRecord {
  schemaVersion: 1;
  worldId: string;
  recordId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  sourceSeq: number;
  turnId: string;
  role: 'user' | 'assistant';
  occurredAt: string;
  content: string;
  status: 'complete' | 'interrupted';
}
export interface ArchiveScope {
  worldId: string;
  agentPreset: string;
  header: SessionHeader;
  inheritedEventCount: number;
  turn: number;
}
export interface ArchiveCursor {
  date: string;
  occurredAt: string;
  recordId: string;
  maxSequence: number;
}
export interface PageQuery {
  worldId: string;
  before?: ArchiveCursor;
  limit: number;
}
export interface RecordPage {
  records: ConversationRecord[];
  nextCursor?: ArchiveCursor;
}
export interface ConversationTurn {
  turnId: string;
  occurredAt: string;
  messages: ConversationRecord[];
}
export interface ArchiveReader {
  readPage(query: PageQuery): Promise<RecordPage>;
  readTurn(worldId: string, turnId: string, afterSeq?: number, limit?: number): Promise<ConversationRecord[]>;
}
