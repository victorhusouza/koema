import { taskStore } from '../../../../lib/server-tasks';
import { RecurrenceConflictError, TaskInputError } from '../../../../lib/task-store';
import { mutationOriginError } from '../../../../lib/request-origin';
export const runtime = 'nodejs';
type Context = { params: Promise<{id:string}> };
async function mutate(request: Request, context: Context, remove: boolean) {
 const rejected=mutationOriginError(request); if(rejected)return rejected;
 const {id} = await context.params;
 if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) return Response.json({error:'Tarefa inválida.'},{status:400});
 try {
  const input = remove ? null : await request.json();
  const store = taskStore();
  try { const result = remove ? store.remove(Number(id)) : store.update(Number(id),input); return result ? Response.json(remove ? {ok:true} : result) : Response.json({error:'Tarefa não encontrada.'},{status:404}); } finally {store.close();}
 } catch (error) {
  if (error instanceof RecurrenceConflictError) return Response.json({error:error.message, conflict:error.code, successorId:error.successorId, successorFingerprint:error.successorFingerprint},{status:409});
  return Response.json({error:error instanceof TaskInputError ? error.message : 'Não foi possível salvar a alteração.'},{status:error instanceof TaskInputError || error instanceof SyntaxError ? 400 : 500});
 }
}
export async function PATCH(request: Request, context: Context) {return mutate(request,context,false);}
export async function DELETE(request: Request, context: Context) {return mutate(request,context,true);}
