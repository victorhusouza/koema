import { join } from 'node:path';
import { openEventStore } from '../../../../lib/event-store.ts';
import { EventInputError } from '../../../../lib/events.ts';
import { eventMutationError } from '../../../../lib/request-origin.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const store = () => openEventStore(process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite'));
type Context = { params: Promise<{ id: string }> };
function parseId(value: string): number | undefined { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : undefined; }

export async function PATCH(request: Request, context: Context) {
 const rejected = eventMutationError(request);
 if (rejected) return rejected;
 const id = parseId((await context.params).id); if (!id) return Response.json({ error: 'Compromisso não encontrado.' }, { status: 404 });
 try {
  const input = await request.json(); const db = store(); try { const event = db.update(id, input); return event ? Response.json(event) : Response.json({ error: 'Compromisso não encontrado.' }, { status: 404 }); } finally { db.close(); }
 } catch (error) {
  if (error instanceof EventInputError || error instanceof SyntaxError) return Response.json({ error: error instanceof Error ? error.message : 'Dados inválidos.' }, { status: 400 });
  return Response.json({ error: 'Não foi possível salvar o compromisso.' }, { status: 500 });
 }
}

export async function DELETE(_request: Request, context: Context) {
 const rejected = eventMutationError(_request, false);
 if (rejected) return rejected;
 const id = parseId((await context.params).id); if (!id) return Response.json({ error: 'Compromisso não encontrado.' }, { status: 404 });
 try { const db = store(); try { return db.remove(id) ? Response.json({ deleted: true }) : Response.json({ error: 'Compromisso não encontrado.' }, { status: 404 }); } finally { db.close(); } }
 catch { return Response.json({ error: 'Não foi possível excluir o compromisso.' }, { status: 500 }); }
}
