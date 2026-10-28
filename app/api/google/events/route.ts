import { googleConfig, GoogleCalendarError, listGoogleEvents, openGoogleStore } from '../../../../lib/google-calendar.ts';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
 const date = new URL(request.url).searchParams.get('date'); if (!date) return Response.json({ error: 'Informe a data para consultar a agenda.' }, { status: 400 });
 const config = googleConfig(); if (!config) return Response.json({ status: 'unconfigured', events: [] }, { headers: { 'Cache-Control': 'no-store' } });
 try {
  const store = openGoogleStore(config);
  try { if (!store.hasTokens()) return Response.json({ status: 'disconnected', events: [] }, { headers: { 'Cache-Control': 'no-store' } }); const events = await listGoogleEvents(config, store, date); return Response.json({ status: 'connected', events }, { headers: { 'Cache-Control': 'no-store' } }); }
  finally { store.close(); }
 } catch (error) {
  return Response.json({ status: error instanceof GoogleCalendarError && error.code === 'not_connected' ? 'disconnected' : 'error', error: error instanceof GoogleCalendarError ? error.message : 'Não foi possível atualizar os eventos do Google Agenda.' }, { status: error instanceof GoogleCalendarError && error.code === 'invalid_date' ? 400 : 502, headers: { 'Cache-Control': 'no-store' } });
 }
}
