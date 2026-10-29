import test from 'node:test';
import assert from 'node:assert/strict';
import { mutationOriginError, sameOrigin, strictMutationOriginAllowed } from '../lib/request-origin.ts';

test('mutation origins require the exact scheme and Host while allowing Next localhost normalization', () => {
 const request = new Request('http://localhost:3000/api/mutate', { headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' } });
 assert.equal(sameOrigin(request), true);
 assert.equal(mutationOriginError(request), undefined);
 for (const origin of ['https://127.0.0.1:3000', 'http://127.0.0.1:4000', 'http://evil.example', 'http://127.0.0.1:3000/path', 'null', 'not a url']) {
  const invalid = new Request('http://localhost:3000/api/mutate', { headers: { host: '127.0.0.1:3000', origin } });
  assert.equal(sameOrigin(invalid), false, origin);
  assert.equal(mutationOriginError(invalid)?.status, 403, origin);
 }
});

test('browser mutations reject a missing Origin and preserve caller response headers', async () => {
 const request = new Request('http://localhost:3000/api/mutate');
 const rejected = mutationOriginError(request, { 'Cache-Control': 'no-store' });
 assert.equal(rejected?.status, 403);
 assert.equal(rejected?.headers.get('Cache-Control'), 'no-store');
 assert.match((await rejected!.json()).error, /origem/i);
});

test('production public origin is canonical and ignores forwarded host and protocol headers', () => {
 const previous = process.env.KOEMA_PUBLIC_ORIGIN;
 process.env.KOEMA_PUBLIC_ORIGIN = 'https://koema.example';
 try {
  assert.equal(strictMutationOriginAllowed(new Request('http://127.0.0.1:3000/api/action', {
   headers: {
    origin: 'https://koema.example',
    host: 'attacker.example',
    'x-forwarded-host': 'attacker.example',
    'x-forwarded-proto': 'https',
   },
  })), true);
  assert.equal(strictMutationOriginAllowed(new Request('http://127.0.0.1:3000/api/action', {
   headers: {
    origin: 'https://attacker.example',
    host: 'koema.example',
    'x-forwarded-host': 'koema.example',
   },
  })), false);
 } finally {
  if (previous === undefined) delete process.env.KOEMA_PUBLIC_ORIGIN;
  else process.env.KOEMA_PUBLIC_ORIGIN = previous;
 }
});
