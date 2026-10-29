import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { strictMutationOriginAllowed } from './request-origin.ts';

const scrypt = promisify(scryptCallback) as (
 password: string,
 salt: Buffer,
 length: number,
 options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const AUTH_COOKIE = 'koema_session';
export const SESSION_SLIDING_MS = 7 * 86400000;
export const SESSION_ABSOLUTE_MS = 30 * 86400000;
const MAX_PASSWORD_BYTES = 1024;
const MAX_SCRYPTS = 2;
let activeScrypts = 0;

export function authDbPath() {
 return process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite');
}

function db() {
 mkdirSync(dirname(authDbPath()), { recursive: true, mode: 0o700 });
 const database = new DatabaseSync(authDbPath());
 database.exec(`PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS koema_owner (
  id INTEGER PRIMARY KEY CHECK(id=1),
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS koema_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES koema_owner(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS koema_sessions_expiry ON koema_sessions(expires_at);
 CREATE TABLE IF NOT EXISTS koema_login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL
 );`);
 return database;
}

function tokenHash(token: string) {
 return createHash('sha256').update(token).digest('hex');
}

async function derive(password: string, salt: Buffer) {
 if (activeScrypts >= MAX_SCRYPTS) throw new Error('Authentication busy');
 activeScrypts++;
 try {
  return await scrypt(password, salt, 64, {
   N: 1 << 15,
   r: 8,
   p: 1,
   maxmem: 64 * 1024 * 1024,
  });
 } finally {
  activeScrypts--;
 }
}

function validateOwnerInput(username: string, password: string) {
 const normalized = username.trim();
 if (!/^[\p{L}\p{N}_.-]{2,64}$/u.test(normalized)) {
  throw new Error('Username must be 2–64 letters, numbers, dots, dashes, or underscores.');
 }
 if ([...password].length < 12 || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
  throw new Error('Password must contain at least 12 characters and at most 1024 bytes.');
 }
 return normalized;
}

export async function initializeOwner(username: string, password: string) {
 const normalized = validateOwnerInput(username, password);
 const salt = randomBytes(16);
 const hash = await derive(password, salt);
 const database = db();
 try {
  database.prepare(`INSERT INTO koema_owner(id,username,password_hash,password_salt,created_at)
   VALUES (1,?,?,?,?)`).run(normalized, hash.toString('hex'), salt.toString('hex'), Date.now());
 } finally {
  database.close();
 }
}

export async function resetOwner(username: string, password: string) {
 const normalized = validateOwnerInput(username, password);
 const salt = randomBytes(16);
 const hash = await derive(password, salt);
 const database = db();
 try {
  database.exec('BEGIN IMMEDIATE');
  try {
   const result = database.prepare(`UPDATE koema_owner
    SET username=?, password_hash=?, password_salt=? WHERE id=1`)
    .run(normalized, hash.toString('hex'), salt.toString('hex'));
   if (Number(result.changes) !== 1) throw new Error('The Koema owner is not initialized.');
   database.prepare('DELETE FROM koema_sessions').run();
   database.prepare('DELETE FROM koema_login_attempts').run();
   database.exec('COMMIT');
  } catch (error) {
   database.exec('ROLLBACK');
   throw error;
  }
 } finally {
  database.close();
 }
}

export function ownerExists() {
 const database = db();
 try {
  return !!database.prepare('SELECT id FROM koema_owner WHERE id=1').get();
 } finally {
  database.close();
 }
}

function clientKeys(request: Request) {
 // Only trust Nginx's single rewritten address when that deployment setting is explicit.
 const address = process.env.KOEMA_TRUST_PROXY === '1'
  ? request.headers.get('x-real-ip')
  : null;
 const validAddress = address && /^[0-9a-f:.]{3,64}$/i.test(address)
  ? `ip:${address}`
  : null;
 return validAddress ? ['global', validAddress] : ['global'];
}

function isBlocked(database: DatabaseSync, key: string, now: number) {
 const row = database.prepare(`SELECT failures,window_start,blocked_until
  FROM koema_login_attempts WHERE key=?`).get(key) as {
   failures: number;
   window_start: number;
   blocked_until: number;
  } | undefined;
 if (!row) return false;
 if (row.blocked_until > now) return true;
 if (now - row.window_start >= 15 * 60000) {
  database.prepare('DELETE FROM koema_login_attempts WHERE key=?').run(key);
 }
 return false;
}

function recordFailure(database: DatabaseSync, key: string, now: number) {
 database.prepare(`DELETE FROM koema_login_attempts
  WHERE window_start < ? AND blocked_until < ?`).run(now - 15 * 60000, now);
 const row = database.prepare(`SELECT failures,window_start
  FROM koema_login_attempts WHERE key=?`).get(key) as {
   failures: number;
   window_start: number;
  } | undefined;
 const inWindow = row && now - row.window_start < 15 * 60000;
 const failures = inWindow ? row.failures + 1 : 1;
 const windowStart = inWindow ? row.window_start : now;
 const blockedUntil = failures >= 5 ? now + 15 * 60000 : 0;
 database.prepare(`INSERT INTO koema_login_attempts(key,failures,window_start,blocked_until)
  VALUES (?,?,?,?)
  ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,
   window_start=excluded.window_start,blocked_until=excluded.blocked_until`)
  .run(key, failures, windowStart, blockedUntil);
 database.prepare(`DELETE FROM koema_login_attempts WHERE key NOT IN (
  SELECT key FROM koema_login_attempts
  ORDER BY CASE WHEN key='global' THEN 0 ELSE 1 END, window_start DESC LIMIT 256
 )`).run();
}

export function cookieToken(request: Request) {
 const cookie = request.headers.get('cookie');
 const value = cookie?.split(';')
  .map(part => part.trim())
  .find(part => part.startsWith(`${AUTH_COOKIE}=`))
  ?.slice(AUTH_COOKIE.length + 1);
 return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function cookieHeader(token: string, maxAge: number, request: Request) {
 const secure = process.env.NODE_ENV === 'production' || new URL(request.url).protocol === 'https:';
 const age = Math.max(0, Math.floor(maxAge / 1000));
 return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
}

export function clearCookie(request: Request) {
 return cookieHeader('', 0, request);
}

export async function login(request: Request, username: string, password: string) {
 const database = db();
 try {
  const now = Date.now();
  const keys = clientKeys(request);
  if (keys.some(key => isBlocked(database, key, now))) {
   return { ok: false as const, limited: true };
  }

  const owner = database.prepare(`SELECT id,username,password_hash,password_salt
   FROM koema_owner WHERE id=1`).get() as {
    id: number;
    username: string;
    password_hash: string;
    password_salt: string;
   } | undefined;
  const validInput = typeof username === 'string'
   && typeof password === 'string'
   && Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES;
  let valid = false;

  if (owner && validInput && owner.username.toLocaleLowerCase() === username.trim().toLocaleLowerCase()) {
   try {
    const actual = await derive(password, Buffer.from(owner.password_salt, 'hex'));
    valid = timingSafeEqual(actual, Buffer.from(owner.password_hash, 'hex'));
   } catch {
    return { ok: false as const, limited: true };
   }
  } else if (validInput) {
   // Keep unknown usernames comparable in cost without storing a fake user.
   try {
    await derive(password, Buffer.alloc(16));
   } catch {
    return { ok: false as const, limited: true };
   }
  }

  if (!valid) {
   for (const key of keys) recordFailure(database, key, now);
   return { ok: false as const, limited: false };
  }

  for (const key of keys) {
   database.prepare('DELETE FROM koema_login_attempts WHERE key=?').run(key);
  }
  database.prepare(`DELETE FROM koema_sessions
   WHERE expires_at<=? OR absolute_expires_at<=?`).run(now, now);
  database.prepare(`DELETE FROM koema_sessions WHERE token_hash IN (
   SELECT token_hash FROM koema_sessions ORDER BY created_at DESC LIMIT -1 OFFSET 9
  )`).run();

  const token = randomBytes(32).toString('hex');
  database.prepare(`INSERT INTO koema_sessions
   (token_hash,owner_id,created_at,expires_at,absolute_expires_at,last_seen_at)
   VALUES (?,1,?,?,?,?)`).run(
    tokenHash(token),
    now,
    now + SESSION_SLIDING_MS,
    now + SESSION_ABSOLUTE_MS,
    now,
   );
  return { ok: true as const, token, username: owner!.username };
 } finally {
  database.close();
 }
}

export async function verifySession(request: Request, forceRefresh = false) {
 const token = cookieToken(request);
 if (!token) return null;

 const database = db();
 try {
  const now = Date.now();
  const hashedToken = tokenHash(token);
  const row = database.prepare(`SELECT s.owner_id,s.expires_at,s.absolute_expires_at,
   s.last_seen_at,o.username FROM koema_sessions s
   JOIN koema_owner o ON o.id=s.owner_id WHERE s.token_hash=?`).get(hashedToken) as {
    owner_id: number;
    expires_at: number;
    absolute_expires_at: number;
    last_seen_at: number;
    username: string;
   } | undefined;
  if (!row) return null;

  if (row.expires_at <= now || row.absolute_expires_at <= now) {
   database.prepare('DELETE FROM koema_sessions WHERE token_hash=?').run(hashedToken);
   return null;
  }

  const expiresAt = Math.min(now + SESSION_SLIDING_MS, row.absolute_expires_at);
  if (forceRefresh || now - row.last_seen_at >= 60000) {
   database.prepare(`UPDATE koema_sessions SET expires_at=?,last_seen_at=?
    WHERE token_hash=?`).run(expiresAt, now, hashedToken);
  }
  return { username: row.username, token, maxAge: expiresAt - now };
 } finally {
  database.close();
 }
}

export async function requireSession(request: Request) {
 const session = await verifySession(request);
 if (session) return null;
 return Response.json({ error: 'Autenticação necessária.' }, {
  status: 401,
  headers: { 'Cache-Control': 'no-store' },
 });
}

export function revokeSession(request: Request) {
 const token = cookieToken(request);
 if (!token) return;
 const database = db();
 try {
  database.prepare('DELETE FROM koema_sessions WHERE token_hash=?').run(tokenHash(token));
 } finally {
  database.close();
 }
}

export const validateMutationOrigin = strictMutationOriginAllowed;
