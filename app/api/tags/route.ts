import { requireSession } from '../../../lib/auth.ts';
import { taskStore } from '../../../lib/server-tasks';
import { TaskInputError } from '../../../lib/task-store';
import { mutationOriginError } from '../../../lib/request-origin';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){const auth=await requireSession(request);if(auth)return auth;try{const store=taskStore();try{return Response.json(store.tags());}finally{store.close();}}catch{return Response.json({error:'Não foi possível carregar as etiquetas.'},{status:500});}}
export async function POST(request:Request){const auth=await requireSession(request);if(auth)return auth;const rejected=mutationOriginError(request);if(rejected)return rejected;try{const store=taskStore();try{return Response.json(store.createTag(await request.json()),{status:201});}finally{store.close();}}catch(error){return Response.json({error:error instanceof TaskInputError?error.message:'Não foi possível criar a etiqueta.'},{status:error instanceof TaskInputError||error instanceof SyntaxError?400:500});}}
