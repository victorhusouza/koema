import { taskStore } from '../../../lib/server-tasks';
import { TaskInputError } from '../../../lib/task-store';
import { mutationOriginError } from '../../../lib/request-origin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() { try { const store=taskStore(); try { return Response.json(store.projects()); } finally { store.close(); } } catch { return Response.json({error:'Não foi possível carregar os projetos.'},{status:500}); } }
export async function POST(request: Request) {
 const rejected=mutationOriginError(request); if(rejected)return rejected;
 try{const input=await request.json();const store=taskStore();try{return Response.json(store.createProject(input),{status:201});}finally{store.close();}}
 catch(error){return Response.json({error:error instanceof TaskInputError?error.message:'Não foi possível salvar o projeto.'},{status:error instanceof TaskInputError||error instanceof SyntaxError?400:500});}
}
