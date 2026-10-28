import { taskStore } from '../../../lib/server-tasks';
import { TaskInputError } from '../../../lib/task-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function originDenied(request: Request) { return !!request.headers.get('origin') && new URL(request.headers.get('origin')!).host !== request.headers.get('host'); }
export async function GET() { try { const store=taskStore(); try { return Response.json(store.areas()); } finally { store.close(); } } catch { return Response.json({error:'Não foi possível carregar as áreas.'},{status:500}); } }
export async function POST(request: Request) {
 if (originDenied(request)) return Response.json({error:'Origem da solicitação não permitida.'},{status:403});
 try { const input=await request.json(); const store=taskStore(); try { return Response.json(store.createArea(input),{status:201}); } finally { store.close(); } }
 catch(error) { return Response.json({error:error instanceof TaskInputError?error.message:'Não foi possível salvar a área.'},{status:error instanceof TaskInputError||error instanceof SyntaxError?400:500}); }
}
