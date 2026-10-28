import { taskStore } from '../../../../../lib/server-tasks';
import { RecurrenceConflictError, TaskInputError } from '../../../../../lib/task-store';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
 const origin = request.headers.get('origin');
 if (origin) {
  try { if (new URL(origin).host !== request.headers.get('host')) return Response.json({error:'Origem da solicitação não permitida.'},{status:403}); }
  catch { return Response.json({error:'Origem da solicitação não permitida.'},{status:403}); }
 }
 const { id } = await context.params;
 if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) return Response.json({error:'Tarefa inválida.'},{status:400});
 try {
  const body = await request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key=>!['successorId','successorFingerprint'].includes(key))) throw new TaskInputError('Confirmação de reabertura inválida.');
  const confirmation = 'successorId' in body || 'successorFingerprint' in body ? body : undefined;
  if (confirmation && (!Number.isSafeInteger(confirmation.successorId) || typeof confirmation.successorFingerprint !== 'string')) throw new TaskInputError('Confirmação de substituição inválida.');
  const db = taskStore();
  try {
   const tasks = db.reopen(Number(id), confirmation);
   if (!tasks) return Response.json({error:'Tarefa não encontrada.'},{status:404});
   return Response.json({tasks, task:tasks.find(task=>task.id===Number(id))});
  } finally { db.close(); }
 } catch (error) {
  if (error instanceof RecurrenceConflictError) return Response.json({error:error.message, conflict:error.code, successorId:error.successorId, successorFingerprint:error.successorFingerprint},{status:409});
  const invalid = error instanceof TaskInputError || error instanceof SyntaxError;
  return Response.json({error:error instanceof TaskInputError ? error.message : invalid ? 'O corpo da solicitação não é um JSON válido.' : 'Não foi possível reabrir a tarefa.'},{status:invalid ? 400 : 500});
 }
}
