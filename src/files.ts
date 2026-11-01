import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const renameAttempts = 10;
const transientRename = new Set(['EPERM', 'EBUSY', 'EACCES']);
function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Atomic file write: a fully written and fsynced temporary file is renamed over the target, so a reader never
 * sees half of it. On Windows a reader, indexer or antivirus can briefly lock the target, so a rename that fails
 * with EPERM/EBUSY/EACCES is retried with a short backoff.
 */
export function durableWrite(file: string, text: string, rename: (from: string, to: string) => void = renameSync): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, 'w');
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    for (let attempt = 1; ; attempt++) {
      try { rename(temporary, file); break; } catch (error) {
        if (attempt >= renameAttempts || !transientRename.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
        sleepSync(Math.min(100, 10 * 2 ** (attempt - 1)));
      }
    }
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

/** `## 名字` sections of a small markdown file, in order. */
export function parseSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let key: string | undefined; let lines: string[] = [];
  const close = () => { if (key !== undefined) sections.set(key, lines.join('\n').trim()); };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) { close(); key = heading[1]!; lines = []; } else if (key !== undefined) lines.push(line);
  }
  close();
  return sections;
}
