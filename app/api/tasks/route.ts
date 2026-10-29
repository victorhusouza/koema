import { requireSession } from '../../../lib/auth.ts';
import { taskStore } from '../../../lib/server-tasks';
import { TaskInputError } from '../../../lib/task-store';
import { mutationOriginError } from '../../../lib/request-origin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request){
 const authResponse = await requireSession(request);
 if (authResponse) return authResponse;
 try { const store = taskStore(); try { return Response.json(store.list()); } finally { store.close(); } }
 catch { return Response.json({error:'Não foi possível carregar suas tarefas.'}, {status:500}); }
}
export async function POST(request: Request){
 const authResponse = await requireSession(request);
 if (authResponse) return authResponse;
 const rejected=mutationOriginError(request); if(rejected)return rejected;
 try { const input = await request.json(); const store = taskStore(); try { return Response.json(store.create(input),{status:201}); } finally {store.close();} }
 catch (error) { return Response.json({error:error instanceof TaskInputError ? error.message : 'Não foi possível salvar a tarefa.'},{status:error instanceof TaskInputError || error instanceof SyntaxError ? 400 : 500}); }
}
