import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PushSubscriptionData, WebPushConfig } from './web-push.ts';

const TEST_COOLDOWN_MS = 30_000;
const DELIVERY_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const DELIVERY_RETENTION_MS = 30 * 86400_000;

export function hashSessionToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function hashPushEndpoint(endpoint: string): string { return createHash('sha256').update(endpoint).digest('hex'); }

function deriveEncryptionKey(config: WebPushConfig): Buffer {
  return createHash('sha256').update('koema-webpush-subscription-encryption-v1\0').update(config.privateKey, 'base64url').digest();
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function encrypt(key: Buffer, value: PushSubscriptionData, endpointHash: string, tokenHash: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${endpointHash}:${tokenHash}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, ciphertext: Buffer, iv: Buffer, authTag: Buffer, endpointHash: string, tokenHash: string): PushSubscriptionData {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`${endpointHash}:${tokenHash}`, 'utf8'));
  decipher.setAuthTag(authTag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as PushSubscriptionData;
}

export type StoredSubscription = { endpointHash: string; tokenHash: string; subscription: PushSubscriptionData };
export type DeliveryClaim = { taskId: number; reminderAt: string; endpointHash: string; leaseToken: string; attempt: number };

export function openNotificationStore(path: string, options: { config?: WebPushConfig | null; now?: () => number } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  const now = options.now ?? Date.now;
  const encryptionKey = options.config ? deriveEncryptionKey(options.config) : null;
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint_hash TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      encrypted_subscription BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      expiration_time INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_subscriptions_session ON push_subscriptions(token_hash, created_at DESC);
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      task_id INTEGER NOT NULL,
      reminder_at TEXT NOT NULL,
      endpoint_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sending','pending','sent','dead')),
      attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_until INTEGER,
      sent_at INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(task_id, reminder_at, endpoint_hash)
    );
    CREATE INDEX IF NOT EXISTS notification_deliveries_retention ON notification_deliveries(updated_at);
    CREATE TABLE IF NOT EXISTS notification_test_cooldowns (
      token_hash TEXT NOT NULL,
      endpoint_hash TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY(token_hash, endpoint_hash)
    );
    CREATE TABLE IF NOT EXISTS scheduler_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);

  function activeSessionClause(): string {
    return tableExists(db, 'koema_sessions')
      ? 'EXISTS (SELECT 1 FROM koema_sessions s WHERE s.token_hash=push_subscriptions.token_hash AND s.expires_at>? AND s.absolute_expires_at>?)'
      : '0';
  }
  function cleanupExpiredSubscriptions(at = now()) {
    const valid = activeSessionClause();
    if (valid === '0') db.prepare('DELETE FROM push_subscriptions').run();
    else db.prepare(`DELETE FROM push_subscriptions WHERE (expiration_time IS NOT NULL AND expiration_time<=?) OR NOT ${valid}`).run(at, at, at);
    if (tableExists(db, 'koema_sessions')) db.prepare('DELETE FROM notification_test_cooldowns WHERE token_hash NOT IN (SELECT token_hash FROM koema_sessions WHERE expires_at>? AND absolute_expires_at>?)').run(at, at);
    db.prepare('DELETE FROM notification_test_cooldowns WHERE sent_at<?').run(at - DELIVERY_RETENTION_MS);
    db.prepare('DELETE FROM notification_deliveries WHERE updated_at<?').run(at - DELIVERY_RETENTION_MS);
  }
  function decryptRow(row: Record<string, unknown>): StoredSubscription | null {
    if (!encryptionKey) return null;
    try {
      return {
        endpointHash: String(row.endpoint_hash),
        tokenHash: String(row.token_hash),
        subscription: decrypt(encryptionKey, Buffer.from(row.encrypted_subscription as Uint8Array), Buffer.from(row.iv as Uint8Array), Buffer.from(row.auth_tag as Uint8Array), String(row.endpoint_hash), String(row.token_hash)),
      };
    } catch {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=?').run(String(row.endpoint_hash));
      return null;
    }
  }

  return {
    saveSubscription(token: string, subscription: PushSubscriptionData) {
      if (!encryptionKey) throw new Error('Push encryption is not configured');
      const tokenHash = hashSessionToken(token);
      const endpointHash = hashPushEndpoint(subscription.endpoint);
      const timestamp = now();
      const encrypted = encrypt(encryptionKey, subscription, endpointHash, tokenHash);
      db.exec('BEGIN IMMEDIATE');
      try {
        cleanupExpiredSubscriptions(timestamp);
        if (!tableExists(db, 'koema_sessions') || !db.prepare('SELECT 1 FROM koema_sessions WHERE token_hash=? AND expires_at>? AND absolute_expires_at>?').get(tokenHash, timestamp, timestamp)) throw new Error('Session expired');
        db.prepare(`INSERT INTO push_subscriptions(endpoint_hash,token_hash,encrypted_subscription,iv,auth_tag,expiration_time,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET token_hash=excluded.token_hash,
          encrypted_subscription=excluded.encrypted_subscription,iv=excluded.iv,auth_tag=excluded.auth_tag,
          expiration_time=excluded.expiration_time,created_at=excluded.created_at,updated_at=excluded.updated_at`)
          .run(endpointHash, tokenHash, encrypted.ciphertext, encrypted.iv, encrypted.authTag, subscription.expirationTime, timestamp, timestamp);
        // Koema has one owner account: keep a global device cap across active sessions.
        db.prepare(`DELETE FROM push_subscriptions WHERE endpoint_hash NOT IN (
          SELECT p.endpoint_hash FROM push_subscriptions p JOIN koema_sessions s ON s.token_hash=p.token_hash
          WHERE s.expires_at>? AND s.absolute_expires_at>? ORDER BY p.created_at DESC,p.endpoint_hash LIMIT 10
        )`).run(timestamp, timestamp);
        db.exec('COMMIT');
        return { ok: true as const };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    removeSubscription(token: string, endpoint: string) {
      const result = db.prepare('DELETE FROM push_subscriptions WHERE token_hash=? AND endpoint_hash=?').run(hashSessionToken(token), hashPushEndpoint(endpoint));
      return Number(result.changes) > 0;
    },
    subscriptionsForSession(token: string, at = now()): StoredSubscription[] {
      cleanupExpiredSubscriptions(at);
      const tokenHash = hashSessionToken(token);
      if (!tableExists(db, 'koema_sessions') || !db.prepare('SELECT 1 FROM koema_sessions WHERE token_hash=? AND expires_at>? AND absolute_expires_at>?').get(tokenHash, at, at)) return [];
      const rows = db.prepare('SELECT * FROM push_subscriptions WHERE token_hash=? AND (expiration_time IS NULL OR expiration_time>?) ORDER BY created_at DESC LIMIT 10').all(tokenHash, at) as Record<string, unknown>[];
      return rows.map(decryptRow).filter((row): row is StoredSubscription => row !== null);
    },
    activeSubscriptions(at = now()): StoredSubscription[] {
      cleanupExpiredSubscriptions(at);
      if (!tableExists(db, 'koema_sessions')) return [];
      const rows = db.prepare(`SELECT p.* FROM push_subscriptions p JOIN koema_sessions s ON s.token_hash=p.token_hash
        WHERE s.expires_at>? AND s.absolute_expires_at>? AND (p.expiration_time IS NULL OR p.expiration_time>?)
        ORDER BY p.created_at DESC LIMIT 10`).all(at, at, at) as Record<string, unknown>[];
      return rows.map(decryptRow).filter((row): row is StoredSubscription => row !== null);
    },
    isSubscriptionActive(tokenHash: string, endpointHash: string, at = now()) {
      if (!tableExists(db, 'koema_sessions')) return false;
      return !!db.prepare(`SELECT 1 FROM push_subscriptions p JOIN koema_sessions s ON s.token_hash=p.token_hash
        WHERE p.token_hash=? AND p.endpoint_hash=? AND s.expires_at>? AND s.absolute_expires_at>? AND (p.expiration_time IS NULL OR p.expiration_time>?)`)
        .get(tokenHash, endpointHash, at, at, at);
    },
    claimManualTests(token: string, at = now()): StoredSubscription[] {
      const tokenHash = hashSessionToken(token);
      db.exec('BEGIN IMMEDIATE');
      try {
        const subscriptions = this.subscriptionsForSession(token, at);
        const eligible: StoredSubscription[] = [];
        for (const subscription of subscriptions) {
          const row = db.prepare('SELECT sent_at FROM notification_test_cooldowns WHERE token_hash=? AND endpoint_hash=?').get(tokenHash, subscription.endpointHash) as { sent_at: number } | undefined;
          if (row && row.sent_at + TEST_COOLDOWN_MS > at) continue;
          db.prepare(`INSERT INTO notification_test_cooldowns(token_hash,endpoint_hash,sent_at) VALUES (?,?,?)
            ON CONFLICT(token_hash,endpoint_hash) DO UPDATE SET sent_at=excluded.sent_at`).run(tokenHash, subscription.endpointHash, at);
          eligible.push(subscription);
        }
        db.exec('COMMIT');
        return eligible;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    claimDelivery(taskId: number, reminderAt: string, endpointHash: string, at = now()): DeliveryClaim | null {
      const leaseToken = randomUUID();
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare(`SELECT status,attempts,next_attempt_at,lease_until FROM notification_deliveries
          WHERE task_id=? AND reminder_at=? AND endpoint_hash=?`).get(taskId, reminderAt, endpointHash) as { status: string; attempts: number; next_attempt_at: number; lease_until: number | null } | undefined;
        if (row?.status === 'sent' || row?.status === 'dead' || row && row.attempts >= MAX_ATTEMPTS || row?.status === 'sending' && (row.lease_until ?? 0) > at || row?.status === 'pending' && row.next_attempt_at > at) {
          db.exec('COMMIT'); return null;
        }
        const attempt = (row?.attempts ?? 0) + 1;
        db.prepare(`INSERT INTO notification_deliveries(task_id,reminder_at,endpoint_hash,status,attempts,next_attempt_at,lease_token,lease_until,sent_at,last_error,updated_at)
          VALUES (?,?,?,'sending',?,?,?, ?,NULL,NULL,?) ON CONFLICT(task_id,reminder_at,endpoint_hash) DO UPDATE SET status='sending',attempts=excluded.attempts,
          lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at`)
          .run(taskId, reminderAt, endpointHash, attempt, at, leaseToken, at + DELIVERY_LEASE_MS, at);
        db.exec('COMMIT');
        return { taskId, reminderAt, endpointHash, leaseToken, attempt };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    markDelivered(claim: DeliveryClaim, at = now()) {
      return Number(db.prepare(`UPDATE notification_deliveries SET status='sent',sent_at=?,updated_at=?,lease_token=NULL,lease_until=NULL,last_error=NULL
        WHERE task_id=? AND reminder_at=? AND endpoint_hash=? AND status='sending' AND lease_token=?`)
        .run(at, at, claim.taskId, claim.reminderAt, claim.endpointHash, claim.leaseToken).changes) === 1;
    },
    releaseDelivery(claim: DeliveryClaim, at = now()) {
      db.prepare(`UPDATE notification_deliveries SET status='pending',attempts=MAX(0,attempts-1),next_attempt_at=?,updated_at=?,lease_token=NULL,lease_until=NULL
        WHERE task_id=? AND reminder_at=? AND endpoint_hash=? AND status='sending' AND lease_token=?`)
        .run(at, at, claim.taskId, claim.reminderAt, claim.endpointHash, claim.leaseToken);
    },
    markFailed(claim: DeliveryClaim, at = now()) {
      const dead = claim.attempt >= MAX_ATTEMPTS;
      const delay = Math.min(3_600_000, 30_000 * 2 ** Math.max(0, claim.attempt - 1));
      db.prepare(`UPDATE notification_deliveries SET status=?,next_attempt_at=?,updated_at=?,lease_token=NULL,lease_until=NULL,last_error='provider-error'
        WHERE task_id=? AND reminder_at=? AND endpoint_hash=? AND status='sending' AND lease_token=?`)
        .run(dead ? 'dead' : 'pending', at + delay, at, claim.taskId, claim.reminderAt, claim.endpointHash, claim.leaseToken);
    },
    markGone(claim: DeliveryClaim, at = now()) {
      db.prepare(`UPDATE notification_deliveries SET status='dead',updated_at=?,lease_token=NULL,lease_until=NULL,last_error='subscription-gone'
        WHERE task_id=? AND reminder_at=? AND endpoint_hash=? AND status='sending' AND lease_token=?`)
        .run(at, claim.taskId, claim.reminderAt, claim.endpointHash, claim.leaseToken);
    },
    removeEndpoint(endpointHash: string) { db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=?').run(endpointHash); },
    heartbeat(at = now()) { db.prepare(`INSERT INTO scheduler_state(key,value) VALUES ('last_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(at); },
    schedulerCursor(): number {
      const row = db.prepare("SELECT value FROM scheduler_state WHERE key='due_task_cursor'").get() as { value: number } | undefined;
      return row?.value ?? 0;
    },
    setSchedulerCursor(taskId: number) {
      db.prepare(`INSERT INTO scheduler_state(key,value) VALUES ('due_task_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(taskId);
    },
    lastHeartbeat(): number | null {
      const row = db.prepare("SELECT value FROM scheduler_state WHERE key='last_heartbeat'").get() as { value: number } | undefined;
      return row?.value ?? null;
    },
    close() { db.close(); },
  };
}
