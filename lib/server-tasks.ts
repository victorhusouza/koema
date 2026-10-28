import { join } from 'node:path';
import { openTaskStore } from './task-store';
// Open per request, so a restarted process and another tab share the same durable state.
export function taskStore() { return openTaskStore(process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite')); }
