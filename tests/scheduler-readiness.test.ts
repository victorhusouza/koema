import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schedulerReady, waitForScheduler } from '../scripts/check-scheduler.ts';

test('readiness waits through first-start initialization and rejects stale heartbeats', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'koema-readiness-'));
  const path = join(directory, 'fictional.sqlite');
  let db: DatabaseSync | undefined;
  try {
    assert.equal(schedulerReady(path), false);
    assert.equal(existsSync(path), false);
    db = new DatabaseSync(path);
    assert.equal(schedulerReady(path), false);
    assert.equal(await waitForScheduler(path, 0), false);
    db.exec('CREATE TABLE scheduler_state(key TEXT PRIMARY KEY,value INTEGER NOT NULL)');
    assert.equal(schedulerReady(path), false);
    const now = Date.now();
    db.prepare('INSERT INTO scheduler_state VALUES (?,?)').run('last_heartbeat', now - 180000);
    assert.equal(schedulerReady(path, now), false);
    db.prepare('UPDATE scheduler_state SET value=?').run(now + 6000);
    assert.equal(schedulerReady(path, now), false);
    db.prepare('UPDATE scheduler_state SET value=?').run(now);
    assert.equal(schedulerReady(path, now), true);
    assert.equal(await waitForScheduler(path, 0), true);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
