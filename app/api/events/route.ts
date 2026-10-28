import { join } from 'node:path';
import { openEventStore } from '../../../lib/event-store.ts';
import { EventInputError } from '../../../lib/events.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const store = () => openEventStore(process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite'));

export async function GET(request: Request) {
 try {
  const date = new URL(request.url).searchParams.get('date');
  if (!date) return Response.json({ error: 'Informe a data para consultar os compromissos.' }, { status: 400 });
  const db = store(); try { return Response.json(db.list(date)); } finally { db.close(); }
 } catch (error) {
  if (error instanceof EventInputError) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ error: 'Não foi possível carregar os compromissos.' }, { status: 500 });
 }
}

export async function POST(request: Request) {
 try {
  const input = await request.json(); const db = store(); try { return Response.json(db.create(input), { status: 201 }); } finally { db.close(); }
 } catch (error) {
  if (error instanceof EventInputError || error instanceof SyntaxError) return Response.json({ error: error instanceof Error ? error.message : 'Dados inválidos.' }, { status: 400 });
  return Response.json({ error: 'Não foi possível salvar o compromisso.' }, { status: 500 });
 }
}
