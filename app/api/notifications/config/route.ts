import { join } from 'node:path';
import { requireSession } from '../../../../lib/auth.ts';
import { openNotificationStore } from '../../../../lib/notification-store.ts';
import { loadWebPushConfig, type WebPushConfig } from '../../../../lib/web-push.ts';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'no-store' };
const dbPath = () => process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite');

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (auth) return auth;
  let config: WebPushConfig | null = null;
  try { config = loadWebPushConfig(); } catch { /* Invalid or absent server keys are exposed only as configured=false. */ }
  const store = openNotificationStore(dbPath());
  try {
    const heartbeat = store.lastHeartbeat();
    const heartbeatAge = heartbeat === null ? null : Date.now() - heartbeat;
    const schedulerEnabled = process.env.KOEMA_SCHEDULER_ENABLED === '1' && heartbeatAge !== null && heartbeatAge >= -5_000 && heartbeatAge < 180_000;
    return Response.json({ configured: !!config, publicKey: config?.publicKey ?? null, schedulerEnabled }, { headers: noStore });
  } finally { store.close(); }
}
