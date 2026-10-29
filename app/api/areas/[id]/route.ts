import { requireSession } from '../../../../lib/auth.ts';
import { taskStore } from '../../../../lib/server-tasks';
import { TaskInputError } from '../../../../lib/task-store';
import { mutationOriginError } from '../../../../lib/request-origin';
export const runtime = 'nodejs';
type Context={params:Promise<{id:string}>};
export async function PATCH(request:Request,context:Context){
 const authResponse = await requireSession(request);
 if (authResponse) return authResponse;
 const rejected=mutationOriginError(request); if(rejected)return rejected;
 const {id}=await context.params;if(!/^\d+$/.test(id))return Response.json({error:'Área inválida.'},{status:400});
 try{const input=await request.json();const store=taskStore();try{const area=store.updateArea(Number(id),input);return area?Response.json(area):Response.json({error:'Área não encontrada.'},{status:404});}finally{store.close();}}
 catch(error){return Response.json({error:error instanceof TaskInputError?error.message:'Não foi possível renomear a área.'},{status:error instanceof TaskInputError||error instanceof SyntaxError?400:500});}
}
