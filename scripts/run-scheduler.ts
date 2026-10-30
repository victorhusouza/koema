import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { runSchedulerTick } from '../lib/scheduler.ts';

let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

function waitOneMinute() {
  return new Promise<void>(resolveWait => {
    const finish = () => {
      clearTimeout(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolveWait();
    };
    const timer = setTimeout(finish, 60_000);
    const stop = () => finish();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function runSchedulerProcess() {
  if (process.env.KOEMA_SCHEDULER_ENABLED !== '1') {
    process.stderr.write('Scheduler disabled. Set KOEMA_SCHEDULER_ENABLED=1 to start it.\n');
    process.exitCode = 1;
    return;
  }
  while (!stopping) {
    try { await runSchedulerTick(); }
    catch { process.stderr.write('Scheduler tick failed.\n'); }
    if (!stopping) await waitOneMinute();
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  void runSchedulerProcess();
}
