import { sameOrigin } from '../../../lib/request-origin.ts';
import { GoogleCalendarError, googleConfig, openGoogleStore } from '../../../lib/google-calendar.ts';
import { openIcalStore, validateGoogleIcalUrl } from '../../../lib/google-ical.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };
export async function GET() {
 try {
  const store = openIcalStore();
  try {
   const config = googleConfig(); let oauthConnected = false;
   if (config) { const oauth = openGoogleStore(config); try { oauthConnected = oauth.hasTokens(); } finally { oauth.close(); } }
   return Response.json({ configured: store.hasUrl(), source: store.getSource(), oauthConfigured: !!config, oauthConnected }, { headers: noStore });
  } finally { store.close(); }
 }
 catch { return Response.json({ error: 'Não foi possível verificar a configuração da agenda.' }, { status: 500, headers: noStore }); }
}
export async function POST(request: Request) {
 if (!sameOrigin(request)) return Response.json({ error: 'Origem da solicitação inválida.' }, { status: 403, headers: noStore });
 try {
  const body = await request.json() as { url?: unknown };
  const url = validateGoogleIcalUrl(body.url);
  const store = openIcalStore(); try { store.saveUrl(url); store.setSource('ical'); } finally { store.close(); }
  return Response.json({ configured: true }, { headers: noStore });
 } catch (error) {
  const clientError = error instanceof GoogleCalendarError;
  return Response.json({ error: clientError ? error.message : 'Não foi possível salvar a configuração da agenda.' }, { status: clientError ? 400 : 500, headers: noStore });
 }
}
export async function DELETE(request: Request) {
 if (!sameOrigin(request)) return Response.json({ error: 'Origem da solicitação inválida.' }, { status: 403, headers: noStore });
 try {
  const store = openIcalStore();
  try {
   store.remove();
   if (store.getSource() === 'ical') store.setSource(null);
  } finally { store.close(); }
  return Response.json({ configured: false }, { headers: noStore });
 }
 catch { return Response.json({ error: 'Não foi possível remover o acesso salvo à agenda.' }, { status: 500, headers: noStore }); }
}
