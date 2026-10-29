import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashSessionToken, openNotificationStore } from '../lib/notification-store.ts';
import { generateWebPushConfig, type PushSubscriptionData } from '../lib/web-push.ts';
import { runSchedulerTick } from '../lib/scheduler.ts';
import { openTaskStore } from '../lib/task-store.ts';

const baseNow = new Date('2026-10-29T12:00:00.000Z');

test('scheduler CLI refuses a disabled environment before opening SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'koema-scheduler-disabled-'));
  const path = join(directory, 'must-not-exist.sqlite');
  const script = fileURLToPath(new URL('../scripts/run-scheduler.ts', import.meta.url));
  try {
    assert.throws(() => execFileSync(process.execPath, ['--experimental-strip-types', script], {
      env: { ...process.env, PAINEL_DB_PATH: path, KOEMA_SCHEDULER_ENABLED: '0' },
      stdio: 'ignore',
    }));
    assert.equal(existsSync(path), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'koema-scheduler-'));
  const path = join(directory, 'koema.sqlite');
  const token = randomBytes(32).toString('hex');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE koema_owner(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT,password_salt TEXT,created_at INTEGER);
    CREATE TABLE koema_sessions(token_hash TEXT PRIMARY KEY,owner_id INTEGER,created_at INTEGER,expires_at INTEGER,absolute_expires_at INTEGER,last_seen_at INTEGER);
    INSERT INTO koema_owner VALUES (1,'Fixture owner','x','x',${baseNow.getTime()});`);
  db.prepare('INSERT INTO koema_sessions(token_hash,owner_id,created_at,expires_at,absolute_expires_at,last_seen_at) VALUES (?,1,?,?,?,?)')
    .run(hashSessionToken(token), baseNow.getTime(), baseNow.getTime() + 86400_000, baseNow.getTime() + 86400_000, baseNow.getTime());
  db.close();
  const config = generateWebPushConfig('mailto:push@example.com');
  const tasks = openTaskStore(path, { now: () => new Date(baseNow) });
  for (const task of tasks.list()) tasks.remove(task.id);
  const task = tasks.create({ title: 'Fixture reminder', project: '', when: 'Planejada', plannedDate: '2026-10-29', reminderAt: '2026-10-29T11:00:00.000Z', notes: '', checklist: [] });
  tasks.close();
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const subscription: PushSubscriptionData = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
  const notificationStore = openNotificationStore(path, { config, now: () => baseNow.getTime() });
  notificationStore.saveSubscription(token, subscription);
  notificationStore.close();
  return { directory, path, token, config, subscription, task };
}

test('scheduler delivers only generic payloads once per task, reminder, and session device', async () => {
  const fixture = setup();
  try {
    const payloads: string[] = [];
    const send = async (_config: typeof fixture.config, _subscription: PushSubscriptionData, payload: string) => { payloads.push(payload); };
    const first = await runSchedulerTick({ dbPath: fixture.path, now: baseNow, config: fixture.config, schedulerEnabled: true, send });
    const second = await runSchedulerTick({ dbPath: fixture.path, now: baseNow, config: fixture.config, schedulerEnabled: true, send });
    assert.deepEqual([first.dueTasks, first.attempted, first.sent], [1, 1, 1]);
    assert.deepEqual([second.attempted, second.sent], [0, 0]);
    assert.equal(payloads.length, 1);
    const payload = JSON.parse(payloads[0]!);
    assert.equal(payload.title, 'Koema');
    assert.equal(payload.body, 'Você tem um lembrete.');
    assert.equal(payload.url, `/prototype?task=${fixture.task.id}`);
    assert.match(payload.tag, /^koema-reminder-/);
    assert.equal(payloads[0]!.includes('Fixture reminder'), false);
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('scheduler retries provider failures with backoff, retains generic errors, and prunes gone devices', async () => {
  const fixture = setup();
  try {
    let attempts = 0;
    const failOnce = async () => { attempts++; if (attempts === 1) throw new Error('provider refused'); };
    const first = await runSchedulerTick({ dbPath: fixture.path, now: baseNow, config: fixture.config, schedulerEnabled: true, send: failOnce });
    const failedDb = new DatabaseSync(fixture.path, { readOnly: true });
    const retainedError = failedDb.prepare('SELECT last_error FROM notification_deliveries WHERE task_id=?').get(fixture.task.id) as { last_error: string };
    failedDb.close();
    assert.equal(retainedError.last_error, 'provider-error');
    const beforeRetry = await runSchedulerTick({ dbPath: fixture.path, now: new Date(baseNow.getTime() + 29_000), config: fixture.config, schedulerEnabled: true, send: failOnce });
    const afterRetry = await runSchedulerTick({ dbPath: fixture.path, now: new Date(baseNow.getTime() + 30_000), config: fixture.config, schedulerEnabled: true, send: failOnce });
    assert.deepEqual([first.attempted, first.failed], [1, 1]);
    assert.equal(beforeRetry.attempted, 0);
    assert.deepEqual([afterRetry.attempted, afterRetry.sent], [1, 1]);
    assert.equal(attempts, 2);

    const taskStore = openTaskStore(fixture.path, { now: () => baseNow });
    const secondTask = taskStore.create({ title: 'Fixture gone endpoint', project: '', when: 'Planejada', plannedDate: '2026-10-29', reminderAt: '2026-10-29T11:01:00.000Z', notes: '', checklist: [] });
    taskStore.close();
    const gone = async () => { const error = new Error('gone') as Error & { statusCode: number }; error.statusCode = 410; throw error; };
    const goneResult = await runSchedulerTick({ dbPath: fixture.path, now: new Date(baseNow.getTime() + 60_000), config: fixture.config, schedulerEnabled: true, send: gone });
    assert.deepEqual([goneResult.attempted, goneResult.failed], [1, 1]);
    const goneDb = new DatabaseSync(fixture.path, { readOnly: true });
    const goneDelivery = goneDb.prepare('SELECT status FROM notification_deliveries WHERE task_id=?').get(secondTask.id) as { status: string };
    goneDb.close();
    assert.equal(goneDelivery.status, 'dead');
    const notifications = openNotificationStore(fixture.path, { config: fixture.config, now: () => baseNow.getTime() + 60_000 });
    try { assert.equal(notifications.activeSubscriptions().length, 0); }
    finally { notifications.close(); }
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('scheduler cursor advances past a full page of already-delivered reminders', async () => {
  const fixture = setup();
  try {
    const tasks = openTaskStore(fixture.path, { now: () => baseNow });
    for (let index = 0; index < 99; index++) {
      tasks.create({ title: `Fixture reminder ${index}`, project: '', when: 'Planejada', plannedDate: '2026-10-29', reminderAt: '2026-10-29T11:00:00.000Z', notes: '', checklist: [] });
    }
    tasks.close();
    const send = async () => {};
    const first = await runSchedulerTick({ dbPath: fixture.path, now: baseNow, config: fixture.config, schedulerEnabled: true, send });
    assert.equal(first.sent, 100);
    const tasksAfterPage = openTaskStore(fixture.path, { now: () => baseNow });
    const later = tasksAfterPage.create({ title: 'Fixture reminder after first page', project: '', when: 'Planejada', plannedDate: '2026-10-29', reminderAt: '2026-10-29T11:00:00.000Z', notes: '', checklist: [] });
    tasksAfterPage.close();
    const sentUrls: string[] = [];
    const second = await runSchedulerTick({ dbPath: fixture.path, now: baseNow, config: fixture.config, schedulerEnabled: true, send: async (_config, _subscription, payload) => { sentUrls.push(JSON.parse(payload).url); } });
    assert.equal(second.sent, 1);
    assert.deepEqual(sentUrls, [`/prototype?task=${later.id}`]);
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('scheduler skips completed tasks and revoked or expired sessions, but always records heartbeat', async () => {
  const fixture = setup();
  try {
    const tasks = openTaskStore(fixture.path, { now: () => baseNow });
    tasks.update(fixture.task.id, { done: true });
    tasks.close();
    const sends: string[] = [];
    const result = await runSchedulerTick({ dbPath: fixture.path, now: baseNow, config: fixture.config, schedulerEnabled: true, send: async (_config, _subscription, payload) => { sends.push(payload); } });
    assert.equal(result.sent, 0);
    assert.equal(sends.length, 0);

    const db = new DatabaseSync(fixture.path);
    db.prepare('UPDATE koema_sessions SET expires_at=? WHERE token_hash=?').run(baseNow.getTime() - 1, hashSessionToken(fixture.token));
    db.close();
    const next = await runSchedulerTick({ dbPath: fixture.path, now: baseNow, config: fixture.config, schedulerEnabled: true, send: async (_config, _subscription, payload) => { sends.push(payload); } });
    const notifications = openNotificationStore(fixture.path, { config: fixture.config, now: () => baseNow.getTime() });
    try { assert.equal(notifications.lastHeartbeat(), baseNow.getTime()); assert.equal(notifications.activeSubscriptions().length, 0); }
    finally { notifications.close(); }
    assert.equal(next.sent, 0);
    assert.equal(sends.length, 0);
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('scheduler materializes schedules and beats even when push keys or the enable flag are absent', async () => {
  const fixture = setup();
  try {
    const tasks = openTaskStore(fixture.path, { now: () => baseNow });
    const schedule = tasks.createSchedule({
      title: 'Fixture schedule', notes: '', checklist: [], areaId: null, projectId: null, headingId: null, tagIds: [],
      deadlineOffset: null, reminderTime: '09:30', rule: { mode: 'calendar', unit: 'day', interval: 1, anchorDate: '2026-10-29' }, nextOccurrenceDate: '2026-10-29',
    });
    tasks.close();
    const result = await runSchedulerTick({ dbPath: fixture.path, now: baseNow, config: null, schedulerEnabled: false, send: async () => { throw new Error('Must not send'); } });
    assert.equal(result.enabled, false);
    assert.equal(result.sent, 0);
    assert.ok(result.materialized >= 1);
    const taskRows = openTaskStore(fixture.path, { now: () => baseNow });
    assert.ok(taskRows.list().some(task => task.scheduleId === schedule.id && task.scheduledFor === '2026-10-29'));
    taskRows.close();
    const store = openNotificationStore(fixture.path, { now: () => baseNow.getTime() });
    try { assert.equal(store.lastHeartbeat(), baseNow.getTime()); }
    finally { store.close(); }
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});
