import { taskStore } from '../../../../lib/server-tasks';
import { TaskInputError } from '../../../../lib/task-store';
export const runtime = 'nodejs';
type Context={params:Promise<{id:string}>};
export async function PATCH(request:Request,context:Context) {
 if(request.headers.get('origin')&&new URL(request.headers.get('origin')!).host!==request.headers.get('host'))return Response.json({error:'Origem da solicitação não permitida.'},{status:403});
 const {id}=await context.params;if(!/^\d+$/.test(id))return Response.json({error:'Área inválida.'},{status:400});
 try{const input=await request.json();const store=taskStore();try{const area=store.updateArea(Number(id),input);return area?Response.json(area):Response.json({error:'Área não encontrada.'},{status:404});}finally{store.close();}}
 catch(error){return Response.json({error:error instanceof TaskInputError?error.message:'Não foi possível renomear a área.'},{status:error instanceof TaskInputError||error instanceof SyntaxError?400:500});}
}
