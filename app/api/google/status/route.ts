import { requireSession } from '../../../../lib/auth.ts';
import { googleConfig, openGoogleStore } from '../../../../lib/google-calendar.ts';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET(request: Request){
 const authResponse = await requireSession(request);
 if (authResponse) return authResponse;
 const config = googleConfig();
 if (!config) return Response.json({ configured: false, connected: false, message: 'A conexão do Google ainda não foi configurada.' }, { headers: { 'Cache-Control': 'no-store' } });
 try { const store = openGoogleStore(config); try { return Response.json({ configured: true, connected: store.hasTokens() }, { headers: { 'Cache-Control': 'no-store' } }); } finally { store.close(); } }
 catch { return Response.json({ configured: true, connected: false, error: 'Não foi possível verificar a conexão salva.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } }); }
}
