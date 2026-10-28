import { taskStore } from '../../../lib/server-tasks';
import { TaskInputError } from '../../../lib/task-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
 try { const store = taskStore(); try { return Response.json(store.list()); } finally { store.close(); } }
 catch { return Response.json({error:'Não foi possível carregar suas tarefas.'}, {status:500}); }
}
export async function POST(request: Request) {
 if (request.headers.get('origin') && new URL(request.headers.get('origin')!).host !== request.headers.get('host')) return Response.json({error:'Origem da solicitação não permitida.'},{status:403});
 try { const input = await request.json(); const store = taskStore(); try { return Response.json(store.create(input),{status:201}); } finally {store.close();} }
 catch (error) { return Response.json({error:error instanceof TaskInputError ? error.message : 'Não foi possível salvar a tarefa.'},{status:error instanceof TaskInputError || error instanceof SyntaxError ? 400 : 500}); }
}
