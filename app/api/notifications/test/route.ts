import { join } from 'node:path';
import { cookieToken, requireSession, verifySession } from '../../../../lib/auth.ts';
import { mutationOriginError } from '../../../../lib/request-origin.ts';
import { sendSessionTest } from '../../../../lib/scheduler.ts';
import { loadWebPushConfig, readJsonBody, WebPushInputError } from '../../../../lib/web-push.ts';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'no-store' };
const dbPath = () => process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite');

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (auth) return auth;
  const originError = mutationOriginError(request, noStore);
  if (originError) return originError;
  let body: unknown;
  try { body = await readJsonBody(request); }
  catch (error) {
    if (error instanceof WebPushInputError) {
      const status = error.message.includes('16 KiB') ? 413 : error.message.includes('usar JSON') ? 415 : 400;
      return Response.json({ error: 'Revise os dados enviados.' }, { status, headers: noStore });
    }
    return Response.json({ error: 'Revise os dados enviados.' }, { status: 400, headers: noStore });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) return Response.json({ error: 'Revise os dados enviados.' }, { status: 400, headers: noStore });
  let config;
  try { config = loadWebPushConfig(); } catch { config = null; }
  if (!config) return Response.json({ error: 'Notificações não estão configuradas no servidor.' }, { status: 503, headers: noStore });
  const session = await verifySession(request);
  const token = session?.token ?? cookieToken(request);
  if (!token) return Response.json({ error: 'Autenticação necessária.' }, { status: 401, headers: noStore });
  try {
    const result = await sendSessionTest({ dbPath: dbPath(), token, config });
    if (!result.attempted) return Response.json({ error: 'Nenhum dispositivo pode receber o teste agora.' }, { status: 409, headers: noStore });
    if (!result.sent) return Response.json({ error: 'Não foi possível enviar o teste.' }, { status: 502, headers: noStore });
    return Response.json({ ok: true }, { headers: noStore });
  } catch { return Response.json({ error: 'Não foi possível enviar o teste.' }, { status: 502, headers: noStore }); }
}
