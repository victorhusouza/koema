import { join } from 'node:path';
import { cookieToken, requireSession, verifySession } from '../../../../lib/auth.ts';
import { openNotificationStore } from '../../../../lib/notification-store.ts';
import { mutationOriginError } from '../../../../lib/request-origin.ts';
import { loadWebPushConfig, readJsonBody, validatePushEndpoint, validatePushSubscription, WebPushInputError } from '../../../../lib/web-push.ts';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'no-store' };
const dbPath = () => process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite');
function inputError(error: unknown) {
  if (!(error instanceof WebPushInputError)) return null;
  const status = error.message.includes('16 KiB') ? 413 : error.message.includes('usar JSON') ? 415 : 400;
  return Response.json({ error: status === 413 ? 'A solicitação excede o limite permitido.' : 'Revise os dados enviados.' }, { status, headers: noStore });
}

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (auth) return auth;
  const originError = mutationOriginError(request, noStore);
  if (originError) return originError;
  let subscription;
  try { subscription = validatePushSubscription(await readJsonBody(request)); }
  catch (error) { return inputError(error) ?? Response.json({ error: 'Não foi possível processar a assinatura.' }, { status: 500, headers: noStore }); }
  let config;
  try { config = loadWebPushConfig(); } catch { config = null; }
  if (!config) return Response.json({ error: 'Notificações não estão configuradas no servidor.' }, { status: 503, headers: noStore });
  const session = await verifySession(request);
  const token = session?.token ?? cookieToken(request);
  if (!token) return Response.json({ error: 'Autenticação necessária.' }, { status: 401, headers: noStore });
  const store = openNotificationStore(dbPath(), { config });
  try {
    store.saveSubscription(token, subscription);
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    if (error instanceof Error && error.message === 'Session expired') return Response.json({ error: 'Autenticação necessária.' }, { status: 401, headers: noStore });
    return Response.json({ error: 'Não foi possível salvar a assinatura.' }, { status: 500, headers: noStore });
  } finally { store.close(); }
}

export async function DELETE(request: Request) {
  const auth = await requireSession(request);
  if (auth) return auth;
  const originError = mutationOriginError(request, noStore);
  if (originError) return originError;
  let endpoint: string;
  try {
    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'endpoint')) throw new WebPushInputError('Invalid body');
    endpoint = validatePushEndpoint((body as Record<string, unknown>).endpoint);
  } catch (error) { return inputError(error) ?? Response.json({ error: 'Revise os dados enviados.' }, { status: 400, headers: noStore }); }
  const session = await verifySession(request);
  const token = session?.token ?? cookieToken(request);
  if (!token) return Response.json({ error: 'Autenticação necessária.' }, { status: 401, headers: noStore });
  const store = openNotificationStore(dbPath());
  try { store.removeSubscription(token, endpoint); return Response.json({ ok: true }, { headers: noStore }); }
  catch { return Response.json({ error: 'Não foi possível remover a assinatura.' }, { status: 500, headers: noStore }); }
  finally { store.close(); }
}
