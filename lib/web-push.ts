import { createECDH, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import webpush from 'web-push';
import type { PushSubscription as WebPushSubscription } from 'web-push';

export type WebPushConfig = { publicKey: string; privateKey: string; subject: string };
export type PushSubscriptionData = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};
export class WebPushInputError extends Error {
  constructor(message: string) { super(message); this.name = 'WebPushInputError'; }
}

export async function readJsonBody(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) throw new WebPushInputError('A solicitação deve usar JSON');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new WebPushInputError('O corpo da solicitação excede 16 KiB');
  if (!request.body) throw new WebPushInputError('Corpo JSON ausente');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new WebPushInputError('O corpo da solicitação excede 16 KiB');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new WebPushInputError('Corpo JSON inválido'); }
}

function decodeBase64Url(value: unknown, name: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new WebPushInputError(`Invalid ${name}`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new WebPushInputError(`Invalid ${name}`);
  return bytes;
}

function normalizeSubject(value: unknown): string {
  if (typeof value !== 'string' || value.length > 320) throw new WebPushInputError('Invalid VAPID subject');
  if (/^mailto:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || (value !== url.origin && value !== `${url.origin}/`)) throw new Error();
    return url.origin;
  } catch { throw new WebPushInputError('VAPID subject must be a canonical HTTPS origin or mailto address'); }
}

/** Validate a VAPID keypair and canonical public contact without exposing private material. */
export function validateWebPushConfig(input: unknown): WebPushConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WebPushInputError('Invalid VAPID configuration');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['publicKey', 'privateKey', 'subject'].includes(key))) throw new WebPushInputError('Unknown VAPID configuration field');
  const publicKey = decodeBase64Url(value.publicKey, 'VAPID public key');
  const privateKey = decodeBase64Url(value.privateKey, 'VAPID private key');
  if (publicKey.length !== 65 || publicKey[0] !== 4 || privateKey.length !== 32) throw new WebPushInputError('VAPID keys must be a P-256 public/private keypair');
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateKey);
    const derived = ecdh.getPublicKey(undefined, 'uncompressed');
    if (!timingSafeEqual(derived, publicKey)) throw new Error();
  } catch { throw new WebPushInputError('VAPID public and private keys do not match'); }
  return { publicKey: publicKey.toString('base64url'), privateKey: privateKey.toString('base64url'), subject: normalizeSubject(value.subject) };
}

/** Load a persisted key file or explicit environment values. Missing config is not an error. */
export function loadWebPushConfig(env: NodeJS.ProcessEnv = process.env): WebPushConfig | null {
  const path = env.WEB_PUSH_KEY_FILE;
  if (path) {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new WebPushInputError('VAPID key file permissions must be 0600');
    return validateWebPushConfig(JSON.parse(readFileSync(path, 'utf8')));
  }
  const { WEB_PUSH_PUBLIC_KEY: publicKey, WEB_PUSH_PRIVATE_KEY: privateKey, WEB_PUSH_SUBJECT: subject } = env;
  if (!publicKey && !privateKey && !subject) return null;
  return validateWebPushConfig({ publicKey, privateKey, subject });
}

const ALLOWED_HOST = (hostname: string) => hostname === 'fcm.googleapis.com'
  || hostname === 'push.services.mozilla.com'
  || hostname === 'updates.push.services.mozilla.com'
  || hostname.endsWith('.push.apple.com')
  || hostname.endsWith('.notify.windows.com');

export function validatePushEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new WebPushInputError('Invalid push endpoint');
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new WebPushInputError('Invalid push endpoint'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || (endpoint.port && endpoint.port !== '443') || !ALLOWED_HOST(endpoint.hostname.toLowerCase()) || endpoint.hostname.endsWith('.')) throw new WebPushInputError('Push endpoint host is not allowed');
  if (!endpoint.pathname || endpoint.pathname === '/') throw new WebPushInputError('Invalid push endpoint path');
  return endpoint.toString();
}

/** Strictly constrain subscriptions to known HTTPS push-provider origins before storage or sending. */
export function validatePushSubscription(input: unknown): PushSubscriptionData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WebPushInputError('Invalid push subscription');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['endpoint', 'expirationTime', 'keys'].includes(key))) throw new WebPushInputError('Unknown push subscription field');
  const endpoint = validatePushEndpoint(value.endpoint);
  if (!value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) throw new WebPushInputError('Invalid push subscription keys');
  const keys = value.keys as Record<string, unknown>;
  if (Object.keys(keys).length !== 2 || Object.keys(keys).some(key => key !== 'p256dh' && key !== 'auth')) throw new WebPushInputError('Push subscription must contain only p256dh and auth keys');
  const p256dh = decodeBase64Url(keys.p256dh, 'p256dh key');
  const auth = decodeBase64Url(keys.auth, 'auth key');
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new WebPushInputError('Invalid push subscription key lengths');
  let expirationTime: number | null = null;
  if (typeof value.expirationTime === 'number' && Number.isFinite(value.expirationTime) && Number.isSafeInteger(Math.floor(value.expirationTime)) && value.expirationTime >= Date.now()) expirationTime = Math.floor(value.expirationTime);
  else if (value.expirationTime !== undefined && value.expirationTime !== null) throw new WebPushInputError('Invalid push subscription expiration');
  return { endpoint, expirationTime, keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') } };
}

export async function sendWebPush(config: WebPushConfig, subscription: PushSubscriptionData, payload: string) {
  return webpush.sendNotification(subscription as WebPushSubscription, payload, {
    vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
    TTL: 3600,
    timeout: 10_000,
    urgency: 'normal',
  });
}

/** Create a persisted keypair. This function does no filesystem writes. */
export function generateWebPushConfig(subject: string): WebPushConfig {
  const keys = webpush.generateVAPIDKeys();
  return validateWebPushConfig({ ...keys, subject });
}
