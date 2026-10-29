import { taskStore } from '../../../../lib/server-tasks';
import { TaskInputError } from '../../../../lib/task-store';
import { mutationOriginError } from '../../../../lib/request-origin';
export const runtime = 'nodejs';
type Context={params:Promise<{id:string}>};
export async function PATCH(request:Request,context:Context) {
 const rejected=mutationOriginError(request); if(rejected)return rejected;
 const {id}=await context.params;if(!/^\d+$/.test(id))return Response.json({error:'Projeto inválido.'},{status:400});
 try{const input=await request.json();const store=taskStore();try{const value=input&&typeof input==='object'&&'status'in input?store.setProjectStatus(Number(id),input.status):store.updateProject(Number(id),input);return value?Response.json(value):Response.json({error:'Projeto não encontrado.'},{status:404});}finally{store.close();}}
 catch(error){return Response.json({error:error instanceof TaskInputError?error.message:'Não foi possível salvar o projeto.'},{status:error instanceof TaskInputError||error instanceof SyntaxError?400:error instanceof RangeError?400:500});}
}
