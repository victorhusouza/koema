import { join } from 'node:path';
import { openBriefStore } from '../../../../lib/brief-store.ts';
import { BriefingInputError, validateBriefingInput, validBriefingDate } from '../../../../lib/briefing.ts';
import { mutationOriginError } from '../../../../lib/request-origin.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ date: string }> };
function store() { return openBriefStore(process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite')); }
export async function GET(_request: Request, context: Context) {
 const { date } = await context.params;
 if (!validBriefingDate(date)) return Response.json({ error: 'Data inválida. Use o formato AAAA-MM-DD.' }, { status: 400 });
 try {
  const db = store();
  try { return Response.json(db.get(date) || { date, Hoje: '', Pendências: '', Semana: '', updatedAt: '' }); } finally { db.close(); }
 } catch { return Response.json({ error: 'Não foi possível carregar o briefing.' }, { status: 500 }); }
}

export async function PUT(request: Request, context: Context) {
 const rejected=mutationOriginError(request); if(rejected)return rejected;
 const { date } = await context.params;
 if (!validBriefingDate(date)) return Response.json({ error: 'Data inválida. Use o formato AAAA-MM-DD.' }, { status: 400 });
 try {
  const content = validateBriefingInput(await request.json());
  const db = store();
  try { return Response.json(db.save(date, content)); } finally { db.close(); }
 } catch (error) {
  const invalid = error instanceof BriefingInputError || error instanceof SyntaxError;
  return Response.json({ error: error instanceof BriefingInputError ? error.message : invalid ? 'O corpo da solicitação não é um JSON válido.' : 'Não foi possível salvar o briefing.' }, { status: invalid ? 400 : 500 });
 }
}
