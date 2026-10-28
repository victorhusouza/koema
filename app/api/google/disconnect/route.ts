import { googleConfig, openGoogleStore, originAllowed, revokeGoogle } from '../../../../lib/google-calendar.ts';
import { openIcalStore } from '../../../../lib/google-ical.ts';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
 const config = googleConfig(); if (!config) return Response.json({ error: 'A conexão do Google ainda não foi configurada.' }, { status: 503 });
 if (!originAllowed(request, config)) return Response.json({ error: 'Não foi possível confirmar a origem da solicitação.' }, { status: 403 });
 try {
  const store = openGoogleStore(config);
  try {
   const revoked = await revokeGoogle(config, store); store.remove();
   const preferences = openIcalStore(); try { if (preferences.getSource() === 'oauth') preferences.setSource(preferences.hasUrl() ? 'ical' : null); } finally { preferences.close(); }
   return Response.json({ connected: false, revoked });
  }
  finally { store.close(); }
 } catch { return Response.json({ error: 'Não foi possível remover a conexão salva.' }, { status: 500 }); }
}
