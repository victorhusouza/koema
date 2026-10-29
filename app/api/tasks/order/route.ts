import { taskStore } from '../../../../lib/server-tasks';
import { TaskInputError } from '../../../../lib/task-store';
import { mutationOriginError } from '../../../../lib/request-origin';
export async function PUT(request: Request) {
 const rejected=mutationOriginError(request); if(rejected)return rejected;
 try {const input=await request.json();const store=taskStore();try{return Response.json(store.reorder(input));}finally{store.close();}}
 catch(error){return Response.json({error:error instanceof TaskInputError ? error.message : 'Não foi possível salvar a ordem.'},{status:error instanceof TaskInputError ? 400 : 500});}
}
