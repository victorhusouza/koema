import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';

/** Readiness probes must tolerate first startup without creating or migrating data. */
export function schedulerReady(path: string, now = Date.now()): boolean {
  if (!existsSync(path)) return false;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_state'").get()) return false;
    const row = db.prepare("SELECT value FROM scheduler_state WHERE key='last_heartbeat'").get();
    if (typeof row?.value !== 'number') return false;
    const age = now - row.value;
    return Number.isFinite(age) && age >= -5000 && age < 180000;
  } catch {
    return false;
  } finally { db?.close(); }
}

export async function waitForScheduler(path: string, timeoutMs = 30000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  do {
    if (schedulerReady(path)) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await setTimeout(Math.min(1000, remaining));
  } while (true);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const path = process.env.PAINEL_DB_PATH;
  if (!path) {
    process.stderr.write('PAINEL_DB_PATH is required.\n');
    process.exitCode = 1;
  } else {
    const ready = await waitForScheduler(path);
    process.stdout.write(ready ? 'Scheduler heartbeat confirmed.\n' : 'Scheduler heartbeat not confirmed within 30 seconds.\n');
    process.exitCode = ready ? 0 : 1;
  }
}
