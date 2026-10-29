import { requireSession } from '../../../../lib/auth.ts';
import { taskStore } from '../../../../lib/server-tasks';
import { TaskInputError } from '../../../../lib/task-store';
import { mutationOriginError } from '../../../../lib/request-origin';

export const runtime='nodejs';
export async function PUT(request:Request){const auth=await requireSession(request);if(auth)return auth;const rejected=mutationOriginError(request);if(rejected)return rejected;const projectId=new URL(request.url).searchParams.get('projectId');if(!projectId||!/^\d+$/.test(projectId)||!Number.isSafeInteger(Number(projectId)))return Response.json({error:'Projeto inválido.'},{status:400});try{const headingIds=await request.json();const store=taskStore();try{return Response.json(store.reorderHeadings(Number(projectId),headingIds));}finally{store.close();}}catch(error){return Response.json({error:error instanceof TaskInputError?error.message:'Não foi possível salvar a ordem.'},{status:error instanceof TaskInputError||error instanceof SyntaxError?400:500});}}
