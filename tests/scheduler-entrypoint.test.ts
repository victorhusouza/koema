import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('scheduler entrypoint runs through a release symlink without touching the database when disabled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'koema-scheduler-entry-'));
  try {
    const current = join(directory, 'current');
    const database = join(directory, 'unused.sqlite');
    symlinkSync(resolve('.'), current, 'dir');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', join(current, 'scripts/run-scheduler.ts')], {
      env: { ...process.env, KOEMA_SCHEDULER_ENABLED: '0', PAINEL_DB_PATH: database }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Scheduler disabled/);
    assert.equal(existsSync(database), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
