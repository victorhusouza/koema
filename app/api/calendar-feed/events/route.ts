import { requireSession } from '../../../../lib/auth.ts';
import { googleConfig, GoogleCalendarError, listGoogleEvents, openGoogleStore } from '../../../../lib/google-calendar.ts';
import { listIcalEvents, openIcalStore } from '../../../../lib/google-ical.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request){
 const authResponse = await requireSession(request);
 if (authResponse) return authResponse;
 const date = new URL(request.url).searchParams.get('date');
 if (!date) return Response.json({ error: 'Informe a data para consultar a agenda.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
 try {
  const store = openIcalStore();
  try {
   const source = store.getSource();
   if (!source) return Response.json({ status: 'disconnected', events: [] }, { headers: { 'Cache-Control': 'no-store' } });
   if (source === 'ical') {
    const secretUrl = store.readUrl();
    if (!secretUrl) return Response.json({ status: 'disconnected', events: [] }, { headers: { 'Cache-Control': 'no-store' } });
    const events = await listIcalEvents(secretUrl, date);
    return Response.json({ status: 'connected', source, events }, { headers: { 'Cache-Control': 'no-store' } });
   }
   const config = googleConfig();
   if (!config) return Response.json({ status: 'error', error: 'A conexão direta do Google ainda não foi configurada pelo desenvolvedor do painel.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
   const oauth = openGoogleStore(config);
   try {
    const events = await listGoogleEvents(config, oauth, date);
    return Response.json({ status: 'connected', source, events }, { headers: { 'Cache-Control': 'no-store' } });
   } finally { oauth.close(); }
  } finally { store.close(); }
 } catch (error) {
  const invalidDate = error instanceof GoogleCalendarError && error.code === 'invalid_date';
  return Response.json({ status: error instanceof GoogleCalendarError && error.code === 'not_connected' ? 'disconnected' : 'error', error: error instanceof GoogleCalendarError ? error.message : 'Não foi possível atualizar os eventos do Google Agenda.' }, { status: invalidDate ? 400 : 502, headers: { 'Cache-Control': 'no-store' } });
 }
}
