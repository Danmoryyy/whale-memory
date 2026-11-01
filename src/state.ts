import { existsSync, readFileSync } from 'node:fs';

/** Characters of her working state read per session; it is meant to be three short lines. */
export const STATE_CAP = 1200;

/**
 * Where she stopped: what she was doing, what blocked her, what comes next. Written by her own file tools in a
 * small file beside her room, read into every session's memory block, so a new session knows the task, not just
 * the talk. The conversation memory says what was said; this says what is still open. Empty when she has not
 * written one.
 */
export function renderState(stateFile: string): string {
  let text: string;
  try { text = existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : ''; }
  catch (error) { return `（这次没能读到 ${stateFile}：${error instanceof Error ? error.message : String(error)}。它还在，下次会再试。）`; }
  if (!text) return '';
  const chars = Array.from(text);
  const capped = chars.length > STATE_CAP;
  const body = `<停在哪>\n${capped ? chars.slice(0, STATE_CAP).join('') : text}\n</停在哪>`;
  return capped ? `${body}\n（后面还有 ${chars.length - STATE_CAP} 字没读进来；三行就够，长的写进 HANDOFF。）` : body;
}
