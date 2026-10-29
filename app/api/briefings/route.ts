import { requireSession } from '../../../lib/auth.ts';
import { join } from 'node:path';
import { openBriefStore } from '../../../lib/brief-store.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function store() { return openBriefStore(process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite')); }

export async function GET(request: Request){
 const authResponse = await requireSession(request);
 if (authResponse) return authResponse;
 try {
  const db = store();
  try { return Response.json(db.list()); } finally { db.close(); }
 } catch { return Response.json({ error: 'Não foi possível carregar o histórico de briefings.' }, { status: 500 }); }
}
