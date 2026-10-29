import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { POST as postSubscription, DELETE as deleteSubscription } from '../app/api/notifications/subscriptions/route.ts';
import { GET as getConfig } from '../app/api/notifications/config/route.ts';
import { POST as postTest } from '../app/api/notifications/test/route.ts';
import { hashPushEndpoint, hashSessionToken, openNotificationStore } from '../lib/notification-store.ts';
import { generateWebPushConfig, validatePushEndpoint, validatePushSubscription, validateWebPushConfig, WebPushInputError, type PushSubscriptionData } from '../lib/web-push.ts';
import { sendSessionTest } from '../lib/scheduler.ts';

const now = Date.now();
const token = randomBytes(32).toString('hex');
const otherToken = randomBytes(32).toString('hex');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'koema-notifications-'));
  const path = join(directory, 'koema.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE koema_owner(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT,password_salt TEXT,created_at INTEGER);
    CREATE TABLE koema_sessions(token_hash TEXT PRIMARY KEY,owner_id INTEGER,created_at INTEGER,expires_at INTEGER,absolute_expires_at INTEGER,last_seen_at INTEGER);
    INSERT INTO koema_owner VALUES (1,'Fixture owner','x','x',${now});`);
  const insert = db.prepare('INSERT INTO koema_sessions(token_hash,owner_id,created_at,expires_at,absolute_expires_at,last_seen_at) VALUES (?,1,?,?,?,?)');
  insert.run(hashSessionToken(token), now, now + 86400_000, now + 86400_000, now);
  db.close();
  return { directory, path };
}

function subscription(endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`): PushSubscriptionData {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

function request(url: string, method: string, body?: string, headers: Record<string, string> = {}) {
  return new Request(url, { method, body, headers: { host: new URL(url).host, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
}

test('VAPID configuration verifies P-256 key pairs and canonical subjects', () => {
  const config = generateWebPushConfig('https://koema.example');
  assert.deepEqual(validateWebPushConfig(config), { ...config, subject: 'https://koema.example' });
  assert.throws(() => validateWebPushConfig({ ...config, publicKey: generateWebPushConfig('mailto:test@example.com').publicKey }), WebPushInputError);
  assert.throws(() => generateWebPushConfig('https://koema.example/path'), WebPushInputError);
  assert.throws(() => generateWebPushConfig('mailto:not-an-address'), WebPushInputError);
});

test('key generator writes an exclusive owner-only file and never prints the private key', () => {
  const { directory } = fixture();
  try {
    const output = join(directory, 'vapid.json');
    const script = fileURLToPath(new URL('../scripts/generate-push-keys.ts', import.meta.url));
    const stdout = execFileSync(process.execPath, ['--experimental-strip-types', script, '--output', output, '--subject', 'https://koema.example'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const stored = JSON.parse(readFileSync(output, 'utf8')) as { publicKey: string; privateKey: string; subject: string };
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(stored.subject, 'https://koema.example');
    assert.equal(stdout.includes(stored.privateKey), false);
    assert.equal(JSON.parse(stdout).publicKey, stored.publicKey);
    assert.throws(() => execFileSync(process.execPath, ['--experimental-strip-types', script, '--output', output, '--subject', 'https://koema.example'], { stdio: 'ignore' }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('subscription validator accepts provider HTTPS endpoints and rejects SSRF or malformed keys', () => {
  const valid = subscription();
  assert.deepEqual(validatePushSubscription(valid), valid);
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/id',
    'https://fcm.googleapis.com.evil.test/fcm/send/id',
    'https://127.0.0.1/latest/meta-data',
    'https://user@fcm.googleapis.com/fcm/send/id',
    'https://fcm.googleapis.com:444/fcm/send/id',
    'https://fcm.googleapis.com/fcm/send/id?x=1',
  ]) assert.throws(() => validatePushEndpoint(endpoint), WebPushInputError);
  assert.throws(() => validatePushSubscription({ ...valid, keys: { ...valid.keys, privateKey: 'secret' } }), WebPushInputError);
  assert.throws(() => validatePushSubscription({ ...valid, keys: { p256dh: 'AA', auth: 'AA' } }), WebPushInputError);
  assert.throws(() => validatePushSubscription({ ...valid, endpoint: `${valid.endpoint}#fragment` }), WebPushInputError);
});

test('subscriptions are encrypted at rest, endpoint-hashed, session-bound, and capped at ten devices', () => {
  const { directory, path } = fixture();
  const config = generateWebPushConfig('mailto:push@example.com');
  const store = openNotificationStore(path, { config, now: () => now });
  try {
    const first = subscription();
    store.saveSubscription(token, first);
    const db = new DatabaseSync(path, { readOnly: true });
    const stored = db.prepare('SELECT endpoint_hash,encrypted_subscription FROM push_subscriptions').get() as { endpoint_hash: string; encrypted_subscription: Uint8Array };
    assert.equal(stored.endpoint_hash, hashPushEndpoint(first.endpoint));
    assert.equal(Buffer.from(stored.encrypted_subscription).includes(Buffer.from(first.endpoint)), false);
    db.close();
    assert.equal(store.subscriptionsForSession(token).length, 1);
    assert.equal(store.subscriptionsForSession(otherToken).length, 0);
    assert.throws(() => store.saveSubscription(otherToken, subscription()), /Session expired/);
    const db2 = new DatabaseSync(path);
    db2.prepare('INSERT INTO koema_sessions(token_hash,owner_id,created_at,expires_at,absolute_expires_at,last_seen_at) VALUES (?,1,?,?,?,?)')
      .run(hashSessionToken(otherToken), now, now + 86400_000, now + 86400_000, now);
    db2.close();
    for (let index = 0; index < 11; index++) store.saveSubscription(token, subscription());
    store.saveSubscription(otherToken, subscription());
    assert.equal(store.activeSubscriptions().length, 10);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('manual tests are cooldown-limited per device and injectable without network access', async () => {
  const { directory, path } = fixture();
  const config = generateWebPushConfig('mailto:push@example.com');
  const store = openNotificationStore(path, { config, now: () => now });
  const sub = subscription();
  store.saveSubscription(token, sub);
  store.close();
  try {
    const payloads: string[] = [];
    const sender = async (_config: typeof config, _subscription: PushSubscriptionData, payload: string) => { payloads.push(payload); };
    assert.deepEqual(await sendSessionTest({ dbPath: path, token, config, now: new Date(now), send: sender }), { attempted: 1, sent: 1, failed: 0 });
    assert.deepEqual(await sendSessionTest({ dbPath: path, token, config, now: new Date(now), send: sender }), { attempted: 0, sent: 0, failed: 0 });
    assert.equal(JSON.parse(payloads[0]!).body, 'Notificações ativadas.');
    assert.equal(payloads.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('notification routes authenticate first, require strict mutation origin, and cap streamed JSON', async () => {
  const { directory, path } = fixture();
  const priorPath = process.env.PAINEL_DB_PATH;
  const priorKeyFile = process.env.WEB_PUSH_KEY_FILE;
  const priorPublic = process.env.WEB_PUSH_PUBLIC_KEY;
  const priorPrivate = process.env.WEB_PUSH_PRIVATE_KEY;
  const priorSubject = process.env.WEB_PUSH_SUBJECT;
  process.env.PAINEL_DB_PATH = path;
  delete process.env.WEB_PUSH_KEY_FILE;
  delete process.env.WEB_PUSH_PUBLIC_KEY;
  delete process.env.WEB_PUSH_PRIVATE_KEY;
  delete process.env.WEB_PUSH_SUBJECT;
  try {
    const unauthenticated = await getConfig(request('https://koema.example/api/notifications/config', 'GET'));
    assert.equal(unauthenticated.status, 401);
    const cookie = `koema_session=${token}`;
    const config = await getConfig(request('https://koema.example/api/notifications/config', 'GET', undefined, { cookie }));
    assert.deepEqual(await config.json(), { configured: false, publicKey: null, schedulerEnabled: false });

    const missingOrigin = await postTest(request('https://koema.example/api/notifications/test', 'POST', '{}', { cookie }));
    assert.equal(missingOrigin.status, 403);
    const oversized = await postSubscription(request('https://koema.example/api/notifications/subscriptions', 'POST', JSON.stringify({ endpoint: 'x'.repeat(17 * 1024) }), { cookie, origin: 'https://koema.example' }));
    assert.equal(oversized.status, 413);
    const blockedProvider = await postSubscription(request('https://koema.example/api/notifications/subscriptions', 'POST', JSON.stringify({ ...subscription('https://169.254.169.254/latest') }), { cookie, origin: 'https://koema.example' }));
    assert.equal(blockedProvider.status, 400);
    const wrongOrigin = await deleteSubscription(request('https://koema.example/api/notifications/subscriptions', 'DELETE', JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/id' }), { cookie, origin: 'https://evil.example' }));
    assert.equal(wrongOrigin.status, 403);
  } finally {
    if (priorPath === undefined) delete process.env.PAINEL_DB_PATH; else process.env.PAINEL_DB_PATH = priorPath;
    if (priorKeyFile === undefined) delete process.env.WEB_PUSH_KEY_FILE; else process.env.WEB_PUSH_KEY_FILE = priorKeyFile;
    if (priorPublic === undefined) delete process.env.WEB_PUSH_PUBLIC_KEY; else process.env.WEB_PUSH_PUBLIC_KEY = priorPublic;
    if (priorPrivate === undefined) delete process.env.WEB_PUSH_PRIVATE_KEY; else process.env.WEB_PUSH_PRIVATE_KEY = priorPrivate;
    if (priorSubject === undefined) delete process.env.WEB_PUSH_SUBJECT; else process.env.WEB_PUSH_SUBJECT = priorSubject;
    rmSync(directory, { recursive: true, force: true });
  }
});
