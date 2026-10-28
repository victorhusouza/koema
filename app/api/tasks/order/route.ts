import { taskStore } from '../../../../lib/server-tasks';
import { TaskInputError } from '../../../../lib/task-store';
export async function PUT(request: Request) {
 if (request.headers.get('origin') && new URL(request.headers.get('origin')!).host !== request.headers.get('host')) return Response.json({error:'Origem não permitida.'},{status:403});
 try {const input=await request.json();const store=taskStore();try{return Response.json(store.reorder(input));}finally{store.close();}}
 catch(error){return Response.json({error:error instanceof TaskInputError ? error.message : 'Não foi possível salvar a ordem.'},{status:error instanceof TaskInputError ? 400 : 500});}
}
