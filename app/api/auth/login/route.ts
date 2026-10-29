import { cookieHeader, login, validateMutationOrigin } from '../../../../lib/auth.ts';

export const runtime = 'nodejs';
const MAX_BODY_BYTES = 4096;

export async function POST(request: Request) {
 if (!validateMutationOrigin(request)) {
  return Response.json({ error: 'Origem da solicitação não permitida.' }, { status: 403 });
 }
 if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) {
  return Response.json({ error: 'Envie os dados no formato JSON.' }, { status: 415 });
 }

 const contentLength = Number(request.headers.get('content-length') || 0);
 if (contentLength > MAX_BODY_BYTES) {
  return Response.json({ error: 'Solicitação excede o limite permitido.' }, { status: 413 });
 }

 let input: unknown;
 const chunks: Uint8Array[] = [];
 let totalBytes = 0;
 try {
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader();
  while (true) {
   const { done, value } = await reader.read();
   if (done) break;
   totalBytes += value.byteLength;
   if (totalBytes > MAX_BODY_BYTES) {
    void reader.cancel().catch(() => {});
    return Response.json({ error: 'Solicitação excede o limite permitido.' }, { status: 413 });
   }
   chunks.push(value);
  }
  const body = new TextDecoder('utf-8', { fatal: true }).decode(
   Buffer.concat(chunks.map(chunk => Buffer.from(chunk))),
  );
  input = JSON.parse(body);
 } catch {
  return Response.json({ error: 'Solicitação inválida.' }, { status: 400 });
 }

 if (!input || typeof input !== 'object' || Array.isArray(input)) {
  return Response.json({ error: 'Solicitação inválida.' }, { status: 400 });
 }
 const { username, password } = input as Record<string, unknown>;
 if (typeof username !== 'string' || typeof password !== 'string'
   || username.length > 64 || Buffer.byteLength(password, 'utf8') > 1024) {
  return Response.json({ error: 'Usuário ou senha inválidos.' }, {
   status: 401,
   headers: { 'Cache-Control': 'no-store' },
  });
 }

 const result = await login(request, username, password);
 if (!result.ok) {
  return Response.json({
   error: result.limited
    ? 'Muitas tentativas. Tente novamente em 15 minutos.'
    : 'Usuário ou senha inválidos.',
  }, {
   status: result.limited ? 429 : 401,
   headers: { 'Cache-Control': 'no-store' },
  });
 }

 return Response.json({ username: result.username }, {
  headers: {
   'Cache-Control': 'no-store',
   'Set-Cookie': cookieHeader(result.token, 7 * 86400000, request),
  },
 });
}
