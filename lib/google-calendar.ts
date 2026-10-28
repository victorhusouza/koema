import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validDate } from './task-dates.ts';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const STATE_COOKIE = 'painel_google_oauth_state';
export type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string; dbPath: string; keyPath?: string; encryptionKey?: string };
export type GoogleTokens = { accessToken: string; refreshToken: string; expiresAt: number; scope: string };
export type GoogleEvent = { id: string; title: string; date: string; time: string | null; endTime: string | null; allDay: boolean; meetingUrl: string | null };
export class GoogleCalendarError extends Error { code: string; constructor(message: string, code = 'calendar_error') { super(message); this.code = code; } }

export function googleConfig(env: Partial<NodeJS.ProcessEnv> = process.env): GoogleConfig | null {
 const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REDIRECT_URI: redirectUri } = env;
 if (!clientId || !clientSecret || !redirectUri) return null;
 try { const uri = new URL(redirectUri); if (uri.protocol !== 'http:' && uri.protocol !== 'https:') return null; if (uri.username || uri.password || uri.search || uri.hash) return null; }
 catch { return null; }
 return { clientId, clientSecret, redirectUri, dbPath: env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite'), keyPath: env.GOOGLE_TOKEN_KEY_FILE, encryptionKey: env.GOOGLE_TOKEN_ENCRYPTION_KEY };
}

type CalendarStorageConfig = Pick<GoogleConfig, 'dbPath' | 'keyPath' | 'encryptionKey'>;
function keyBytes(config: CalendarStorageConfig): Buffer {
 if (config.encryptionKey) {
  const value = Buffer.from(config.encryptionKey, 'base64');
  if (value.length !== 32) throw new GoogleCalendarError('A chave local de proteção da conexão está inválida.', 'key_invalid');
  return value;
 }
 const path = config.keyPath || join(dirname(config.dbPath), '.google-calendar.key');
 mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
 try { readFileSync(path); }
 catch {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, randomBytes(32), { mode: 0o600, flag: 'wx' });
  try { linkSync(temp, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { unlinkSync(temp); throw error; } }
  finally { try { unlinkSync(temp); } catch {} }
 }
 chmodSync(path, 0o600);
 const key = readFileSync(path);
 if (key.length !== 32) throw new GoogleCalendarError('A chave local de proteção da conexão está inválida.', 'key_invalid');
 return key;
}
function encrypt(value: GoogleTokens, config: GoogleConfig): string {
 const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', keyBytes(config), iv);
 const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
 return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64')).join('.');
}
function decrypt(value: string, config: GoogleConfig): GoogleTokens {
 try {
  const [iv, tag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(config), iv); decipher.setAuthTag(tag);
  const parsed = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString()) as GoogleTokens;
  if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string' || typeof parsed.expiresAt !== 'number') throw new Error('invalid');
  return parsed;
 } catch { throw new GoogleCalendarError('Não foi possível ler a conexão salva. Verifique a chave local de proteção.', 'token_storage_error'); }
}

export function openGoogleStore(config: GoogleConfig) {
 mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
 const db = new DatabaseSync(config.dbPath);
 db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS google_calendar_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
 const get = () => db.prepare("SELECT value FROM google_calendar_metadata WHERE key='tokens'").get() as { value: string } | undefined;
 return {
  hasTokens() { return !!get(); },
  read() { const row = get(); return row ? decrypt(row.value, config) : null; },
  save(tokens: GoogleTokens) { const payload = encrypt(tokens, config); db.prepare("INSERT INTO google_calendar_metadata(key,value) VALUES ('tokens',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(payload); },
  remove() { db.prepare("DELETE FROM google_calendar_metadata WHERE key='tokens'").run(); },
  raw() { return get()?.value ?? null; },
  close() { db.close(); },
 };
}

// The Google iCal address is a bearer secret. Keep it in the same protected
// SQLite file and use the same per-installation AES-GCM key as OAuth tokens.
export function openCalendarFeedStore(config: CalendarStorageConfig) {
 mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
 const db = new DatabaseSync(config.dbPath);
 db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS google_calendar_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
 const get = () => db.prepare("SELECT value FROM google_calendar_metadata WHERE key='ical_url'").get() as { value: string } | undefined;
 return {
  getSource(): 'ical' | 'oauth' | null { const row = db.prepare("SELECT value FROM google_calendar_metadata WHERE key='active_source'").get() as { value: string } | undefined; return row?.value === 'ical' || row?.value === 'oauth' ? row.value : null; },
  setSource(source: 'ical' | 'oauth' | null) { if (!source) db.prepare("DELETE FROM google_calendar_metadata WHERE key='active_source'").run(); else db.prepare("INSERT INTO google_calendar_metadata(key,value) VALUES ('active_source',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(source); },
  hasUrl() { return !!get(); },
  readUrl() {
   const row = get(); if (!row) return null;
   try {
    const [iv, tag, ciphertext] = row.value.split('.').map(part => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(config), iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString();
   } catch { throw new GoogleCalendarError('Não foi possível ler a conexão salva. Verifique a chave local de proteção.', 'token_storage_error'); }
  },
  saveUrl(url: string) {
   const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', keyBytes(config), iv);
   const ciphertext = Buffer.concat([cipher.update(url), cipher.final()]);
   const encrypted = [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64')).join('.');
   db.prepare("INSERT INTO google_calendar_metadata(key,value) VALUES ('ical_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(encrypted);
  },
  remove() { db.prepare("DELETE FROM google_calendar_metadata WHERE key='ical_url'").run(); },
  close() { db.close(); },
 };
}

export function stateMatches(query: string | null, cookie: string | null, expires: string | null, now = Date.now()): boolean {
 if (!query || !cookie || !expires || !/^\d{13}$/.test(expires) || Number(expires) < now || !/^[a-f0-9]{64}$/.test(query) || !/^[a-f0-9]{64}$/.test(cookie)) return false;
 const a = Buffer.from(query); const b = Buffer.from(cookie);
 return a.length === b.length && timingSafeEqual(a, b);
}
export function makeState(now = Date.now()) { return { value: randomBytes(32).toString('hex'), expires: String(now + 10 * 60 * 1000) }; }
export function cookieValue(request: Request, name: string): string | null {
 const cookie = request.headers.get('cookie'); if (!cookie) return null;
 for (const item of cookie.split(';')) { const [key, ...value] = item.trim().split('='); if (key === name) return value.join('=') || null; }
 return null;
}
export function clearStateCookie(secure: boolean) {
 return [`${STATE_COOKIE}=; Max-Age=0; Path=/api/google; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`, `${STATE_COOKIE}_expires=; Max-Age=0; Path=/api/google; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`];
}
export function redirectResponse(url: URL, cookies: string[] = []) {
 const headers = new Headers({ Location: url.toString(), 'Cache-Control': 'no-store' });
 for (const cookie of cookies) headers.append('Set-Cookie', cookie);
 return new Response(null, { status: 302, headers });
}
export function originAllowed(request: Request, config: GoogleConfig) {
 const origin = request.headers.get('origin'); if (!origin) return false;
 try { return new URL(origin).origin === new URL(config.redirectUri).origin; } catch { return false; }
}

async function postForm(url: string, params: Record<string, string>, fetcher: typeof fetch) {
 const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
 let body: any; try { body = await response.json(); } catch { body = {}; }
 if (!response.ok) throw new GoogleCalendarError(body.error === 'invalid_grant' ? 'A conexão com o Google expirou. Conecte novamente.' : 'Não foi possível concluir a conexão com o Google.', body.error || 'oauth_error');
 return body;
}
export function authorizationUrl(config: GoogleConfig, state: string) {
 const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
 url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: GOOGLE_SCOPE, access_type: 'offline', prompt: 'consent', state }).toString();
 return url;
}
export async function exchangeCode(config: GoogleConfig, code: string, fetcher: typeof fetch = fetch): Promise<GoogleTokens> {
 const body = await postForm('https://oauth2.googleapis.com/token', { code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code' }, fetcher);
 if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.expires_in !== 'number') throw new GoogleCalendarError('O Google não forneceu uma conexão completa. Tente conectar novamente.', 'oauth_incomplete');
 if (typeof body.scope === 'string' && !body.scope.split(' ').includes(GOOGLE_SCOPE)) throw new GoogleCalendarError('A autorização não incluiu leitura de eventos. Conecte novamente e permita esse acesso.', 'scope_missing');
 return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000, scope: body.scope || GOOGLE_SCOPE };
}
export async function accessToken(config: GoogleConfig, store: ReturnType<typeof openGoogleStore>, fetcher: typeof fetch = fetch): Promise<string> {
 const tokens = store.read(); if (!tokens) throw new GoogleCalendarError('Google Agenda não está conectado.', 'not_connected');
 if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
 try {
  const body = await postForm('https://oauth2.googleapis.com/token', { client_id: config.clientId, client_secret: config.clientSecret, refresh_token: tokens.refreshToken, grant_type: 'refresh_token' }, fetcher);
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') throw new GoogleCalendarError('O Google não renovou a conexão. Conecte novamente.', 'refresh_error');
  store.save({ ...tokens, accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
 } catch (error) {
  if (error instanceof GoogleCalendarError && error.code === 'invalid_grant') store.remove();
  throw error;
 }
}

export function dayBounds(date: string) {
 if (!validDate(date)) throw new GoogleCalendarError('Informe uma data válida para consultar a agenda.', 'invalid_date');
 const next = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1)).toISOString().slice(0, 10);
 return { timeMin: `${date}T00:00:00-03:00`, timeMax: `${next}T00:00:00-03:00` };
}
function localParts(value: string): { date: string; time: string } {
 const date = new Date(value); const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Belem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
 const get = (type: string) => parts.find(part => part.type === type)?.value || '00';
 return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
function meetingLink(event: any): string | null {
 const candidates = [event.hangoutLink, ...(event.conferenceData?.entryPoints || []).filter((entry: any) => entry.entryPointType === 'video').map((entry: any) => entry.uri)];
 for (const candidate of candidates) { try { const url = new URL(candidate); if (url.protocol === 'https:') return url.toString(); } catch {} }
 return null;
}
export function normalizeEvent(event: any): GoogleEvent | null {
 if (!event || typeof event.id !== 'string' || event.status === 'cancelled') return null;
 const title = typeof event.summary === 'string' && event.summary.trim() ? event.summary.trim() : 'Evento sem título';
 const allDay = typeof event.start?.date === 'string';
 if (allDay) return { id: event.id, title, date: event.start.date, time: null, endTime: null, allDay: true, meetingUrl: meetingLink(event) };
 if (typeof event.start?.dateTime !== 'string') return null;
 const start = localParts(event.start.dateTime); const end = typeof event.end?.dateTime === 'string' ? localParts(event.end.dateTime) : null;
 return { id: event.id, title, date: start.date, time: start.time, endTime: end && end.date === start.date ? end.time : null, allDay: false, meetingUrl: meetingLink(event) };
}
export async function listGoogleEvents(config: GoogleConfig, store: ReturnType<typeof openGoogleStore>, date: string, fetcher: typeof fetch = fetch): Promise<GoogleEvent[]> {
 const bounds = dayBounds(date); const token = await accessToken(config, store, fetcher); const events: GoogleEvent[] = []; let pageToken: string | undefined;
 for (let page = 0; page < 20; page++) {
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.search = new URLSearchParams({ ...bounds, singleEvents: 'true', orderBy: 'startTime', timeZone: 'America/Belem', maxResults: '250', ...(pageToken ? { pageToken } : {}) }).toString();
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
   let body: any; try { body = await response.json(); } catch { body = {}; }
   if (response.status === 401 || body.error?.status === 'UNAUTHENTICATED') { store.remove(); throw new GoogleCalendarError('A conexão com o Google expirou. Conecte novamente.', 'not_connected'); }
   throw new GoogleCalendarError('Não foi possível atualizar os eventos do Google Agenda. Tente novamente.', 'calendar_fetch_error');
  }
  let body: any; try { body = await response.json(); } catch { throw new GoogleCalendarError('O Google retornou uma resposta inválida. Tente atualizar novamente.', 'calendar_fetch_error'); }
  if (!Array.isArray(body.items)) throw new GoogleCalendarError('O Google retornou uma resposta inválida. Tente atualizar novamente.', 'calendar_fetch_error');
  events.push(...body.items.map(normalizeEvent).filter((event: GoogleEvent | null): event is GoogleEvent => !!event));
  pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
  if (!pageToken) return events;
 }
 throw new GoogleCalendarError('A agenda tem muitos eventos para carregar agora. Reduza o período ou tente novamente.', 'pagination_limit');
}
export async function revokeGoogle(config: GoogleConfig, store: ReturnType<typeof openGoogleStore>, fetcher: typeof fetch = fetch) {
 const tokens = store.read(); if (!tokens) return false;
 try { const response = await fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refreshToken }) }); return response.ok; }
 catch { return false; }
}
