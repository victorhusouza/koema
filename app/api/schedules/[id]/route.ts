import { requireSession } from '../../../../lib/auth.ts';
import { taskStore } from '../../../../lib/server-tasks';
import { TaskInputError } from '../../../../lib/task-store';
import { mutationOriginError } from '../../../../lib/request-origin';

export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
async function mutate(request:Request,context:Context,remove:boolean){const rejected=mutationOriginError(request);if(rejected)return rejected;const {id}=await context.params;if(!/^\d+$/.test(id)||!Number.isSafeInteger(Number(id)))return Response.json({error:'Repetição inválida.'},{status:400});try{const store=taskStore();try{const result=remove?store.removeSchedule(Number(id)):store.updateSchedule(Number(id),await request.json());return result?Response.json(remove?{ok:true}:result):Response.json({error:'Repetição não encontrada.'},{status:404});}finally{store.close();}}catch(error){return Response.json({error:error instanceof TaskInputError?error.message:'Não foi possível salvar a repetição.'},{status:error instanceof TaskInputError||error instanceof SyntaxError?400:500});}}
export async function PATCH(request:Request,context:Context){const auth=await requireSession(request);if(auth)return auth;return mutate(request,context,false);}
export async function DELETE(request:Request,context:Context){const auth=await requireSession(request);if(auth)return auth;return mutate(request,context,true);}
