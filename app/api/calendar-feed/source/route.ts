import { sameOrigin } from '../../../../lib/request-origin.ts';
import { googleConfig, openGoogleStore } from '../../../../lib/google-calendar.ts';
import { openIcalStore } from '../../../../lib/google-ical.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
 if (!sameOrigin(request)) return Response.json({ error: 'Origem da solicitação inválida.' }, { status: 403 });
 try {
  const { source } = await request.json() as { source?: unknown };
  if (source !== 'ical' && source !== 'oauth') return Response.json({ error: 'Escolha uma forma de conexão válida.' }, { status: 400 });
  const store = openIcalStore();
  try {
   if (source === 'ical') {
    if (!store.hasUrl()) return Response.json({ error: 'Cadastre primeiro o endereço iCal secreto.' }, { status: 409 });
   } else {
    const config = googleConfig(); if (!config) return Response.json({ error: 'A conexão direta ainda precisa ser configurada pelo desenvolvedor do painel.' }, { status: 503 });
    const oauth = openGoogleStore(config); try { if (!oauth.hasTokens()) return Response.json({ error: 'Conecte uma conta Google antes de escolher esta forma de acesso.' }, { status: 409 }); } finally { oauth.close(); }
   }
   store.setSource(source);
   return Response.json({ source }, { headers: { 'Cache-Control': 'no-store' } });
  } finally { store.close(); }
 } catch { return Response.json({ error: 'Não foi possível mudar a forma de acesso ao Google Agenda.' }, { status: 500 }); }
}
