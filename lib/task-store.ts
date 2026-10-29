import { localDay, legacyDate, validDate, addDays, todayTasks } from './task-dates.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { seed, type Task } from './tasks.ts';
import { capitalizeInitial, capitalizeLines } from './text.ts';

export class TaskInputError extends Error {}
export type RecurrenceConflictCode = 'edited-successor' | 'completed-successor' | 'completed-history';
export class RecurrenceConflictError extends Error {
 code: RecurrenceConflictCode;
 successorId?: number;
 successorFingerprint?: string;
 constructor(code: RecurrenceConflictCode, message: string, successorId?: number, successorFingerprint?: string) {
  super(message); this.code=code; this.successorId=successorId; this.successorFingerprint=successorFingerprint;
 }
}
export type ReopenConfirmation = { successorId: number; successorFingerprint: string };
type StoreOptions = { now?: () => Date };
type TaskPatch = Partial<Omit<Task, 'id' | 'seriesId' | 'occurrence' | 'previousId' | 'successorId' | 'successorSnapshot'>>;
export type Area = { id: number; name: string };
export type Project = { id: number; areaId: number; areaName: string; name: string; status: 'open' | 'completed'; completedAt?: string };

function contentSnapshot(task: Task): string {
 return JSON.stringify({
  title: task.title, when: task.when,
  plannedDate: task.plannedDate ?? null, deadline: task.deadline ?? null,
  notes: task.notes, checklist: task.checklist,
  recurrence: task.recurrence ?? null, recurrenceAnchor:task.recurrenceAnchor??null,
  // Organization names and a project's parent area are derived labels. A project
  // move must not look like a direct edit to every task assigned to that project.
  areaId:task.projectId ? null : task.areaId??null, projectId:task.projectId??null,
 });
}
function dayDistance(from: string, to: string): number {
 return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}
function weeklyNext(anchor: string, after: string): string {
 const weekday=new Date(`${anchor}T12:00:00Z`).getUTCDay();let candidate=addDays(after,1);
 while(new Date(`${candidate}T12:00:00Z`).getUTCDay()!==weekday)candidate=addDays(candidate,1);
 return candidate;
}
function monthlyNext(anchor: string, after: string): string {
 const anchorDay=Number(anchor.slice(8,10));const date=new Date(`${after}T12:00:00Z`);
 for(let offset=0;offset<2400;offset++){
  const month=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+offset,1));
  const lastDay=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+1,0)).getUTCDate();
  const candidate=`${month.getUTCFullYear()}-${String(month.getUTCMonth()+1).padStart(2,'0')}-${String(Math.min(anchorDay,lastDay)).padStart(2,'0')}`;
  if(candidate>after)return candidate;
 }
 throw new TaskInputError('Não foi possível calcular a próxima data mensal.');
}

export function openTaskStore(path: string, options: StoreOptions = {}) {
 mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
 const db = new DatabaseSync(path);
 const now = options.now || (() => new Date());
 try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  // Versioned migrations are atomic, including first-run example data.
  db.exec('BEGIN IMMEDIATE');
  try {
   const version = (db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version;
   if (version === 0) {
    db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL); PRAGMA user_version=1;');
    const insert = db.prepare('INSERT INTO tasks (id, body) VALUES (?, ?)');
    for (const task of seed) insert.run(task.id, JSON.stringify({...task, completed: task.done ? '2026-10-28T10:45:00.000Z' : undefined}));
   }
   if (version < 2) {
    const rows = db.prepare('SELECT id, body FROM tasks ORDER BY id').all();
    const update = db.prepare('UPDATE tasks SET body=? WHERE id=?');
    for (const row of rows) { const task=JSON.parse(row.body as string); update.run(JSON.stringify({...task, plannedDate:legacyDate(task.when,version===0 ? localDay() : '2026-10-28'), deadline:null, position:Number(row.id)}),Number(row.id)); }
    db.exec('PRAGMA user_version=2');
   }
   if (version < 3) {
    const rows = db.prepare('SELECT id, body FROM tasks ORDER BY id').all();
    const update = db.prepare('UPDATE tasks SET body=? WHERE id=?');
    for (const row of rows) {
     const id = Number(row.id); const task = JSON.parse(row.body as string) as Task;
     // Preserve the existing daily task as the first occurrence of its own series.
     if (task.recurrence === 'daily' && !task.seriesId) update.run(JSON.stringify({...task, seriesId:id, occurrence:1}), id);
    }
    db.exec('PRAGMA user_version=3');
   }
   if (version < 4) {
    db.exec("CREATE TABLE areas (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE); CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, area_id INTEGER NOT NULL REFERENCES areas(id), name TEXT NOT NULL COLLATE NOCASE, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')), completed_at TEXT, UNIQUE(area_id,name)); CREATE INDEX tasks_area_id ON tasks(json_extract(body,'$.areaId')); CREATE INDEX tasks_project_id ON tasks(json_extract(body,'$.projectId'));");
    const addArea=db.prepare('INSERT OR IGNORE INTO areas(name) VALUES (?)');
    const findArea=db.prepare('SELECT id FROM areas WHERE name=?');
    const addProject=db.prepare('INSERT OR IGNORE INTO projects(area_id,name) VALUES (?,?)');
    const findProject=db.prepare('SELECT id FROM projects WHERE area_id=? AND name=?');
    const rows=db.prepare('SELECT id,body FROM tasks ORDER BY id').all();
    const update=db.prepare('UPDATE tasks SET body=? WHERE id=?');
    for (const row of rows) {
     const id=Number(row.id); const task=JSON.parse(row.body as string) as Task; const label=(task.project || '').trim();
     if (!label) continue;
     const pieces=label.split(' · ').map(value=>value.trim()).filter(Boolean);
     const areaName=pieces.length>1 ? pieces[0] : label;
     addArea.run(areaName);
     const areaId=Number((findArea.get(areaName) as {id:number}).id);
     if (pieces.length>1) {
      const projectName=pieces.slice(1).join(' · '); addProject.run(areaId,projectName);
      const projectId=Number((findProject.get(areaId,projectName) as {id:number}).id);
      update.run(JSON.stringify({...task,areaId,projectId}),id);
     } else update.run(JSON.stringify({...task,areaId,projectId:null}),id);
    }
    db.exec('PRAGMA user_version=4');
   }
   if (version < 5) {
    const rows=db.prepare('SELECT id,body FROM tasks').all();const update=db.prepare('UPDATE tasks SET body=? WHERE id=?');
    for(const row of rows){const task=JSON.parse(row.body as string) as Task;if((task.recurrence==='weekly'||task.recurrence==='monthly')&&!task.recurrenceAnchor)update.run(JSON.stringify({...task,recurrenceAnchor:task.plannedDate||localDay(now())}),Number(row.id));}
    const bodies=new Map(db.prepare('SELECT id,body FROM tasks').all().map(row=>[Number(row.id),JSON.parse(row.body as string) as Task]));
    const projectMap=new Map((db.prepare('SELECT p.id,p.area_id AS areaId,p.name,a.name AS areaName FROM projects p JOIN areas a ON a.id=p.area_id').all() as {id:number;areaId:number;name:string;areaName:string}[]).map(project=>[project.id,project]));
    const areaMap=new Map((db.prepare('SELECT id,name FROM areas').all() as {id:number;name:string}[]).map(area=>[area.id,area.name]));
    for(const [id,raw] of bodies){
     if(raw.successorId===undefined)continue;const successor=bodies.get(raw.successorId);if(!successor)continue;
     const project=successor.projectId?projectMap.get(successor.projectId):undefined;const areaId=project?.areaId??successor.areaId??null;
     const hydrated={...successor,areaId,projectId:project?.id??null,project:project?`${project.areaName} · ${project.name}`:areaMap.get(areaId??-1)??''};
     const baseline=JSON.parse(contentSnapshot(hydrated)) as Record<string,unknown>;
     let saved:Record<string,unknown>={};
     try { const parsed=JSON.parse(raw.successorSnapshot||'{}');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))saved=parsed; } catch { /* Preserve a conflict on malformed legacy snapshots. */ }
     const snapshot={...baseline,...saved};delete snapshot.project;
     if(!('projectId' in saved)&&!('areaId' in saved)){
      const legacyLabel=typeof saved.project==='string'?saved.project:'';
      const matches=[...projectMap.values()].filter(item=>`${item.areaName} · ${item.name}`===legacyLabel||(item.name===legacyLabel&&[...projectMap.values()].filter(other=>other.name===legacyLabel).length===1));
      const oldProject=matches.length===1?matches[0]:undefined;
      const oldArea=[...areaMap.entries()].find(([,name])=>name===legacyLabel)?.[0];
      if(oldProject){snapshot.areaId=null;snapshot.projectId=oldProject.id;}
      else if(oldArea!==undefined){snapshot.areaId=oldArea;snapshot.projectId=null;}
      else if(legacyLabel||successor.projectId||successor.areaId){snapshot.areaId=null;snapshot.projectId='__legacy_destination_unresolved__';}
      else {snapshot.areaId=null;snapshot.projectId=null;}
     }else if(snapshot.projectId){snapshot.areaId=null;}
     // Anchor is a field introduced by this migration. Seed it from the stored
     // successor without changing the task's own schedule-derived anchor.
     snapshot.recurrenceAnchor=successor.recurrenceAnchor??null;
     update.run(JSON.stringify({...raw,successorSnapshot:JSON.stringify(snapshot)}),id);
    }
    db.exec('PRAGMA user_version=5');
   }
   if (version < 6) {
    // Normalize only the derived display label and project-parent area from the
    // saved fingerprint. Preserve saved task content and destination IDs.
    const rows=db.prepare('SELECT id,body FROM tasks').all();
    const bodies=new Map(rows.map(row=>[Number(row.id),JSON.parse(row.body as string) as Task]));
    const update=db.prepare('UPDATE tasks SET body=? WHERE id=?');
    for(const [id,raw] of bodies){
     if(raw.successorId===undefined)continue;
     const successor=bodies.get(raw.successorId);if(!successor)continue;
     let snapshot:Record<string,unknown>;
     try {
      snapshot=JSON.parse(raw.successorSnapshot||'{}') as Record<string,unknown>;
      if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw new Error('invalid snapshot');
     } catch { snapshot={}; }
     // Keep the old snapshot's task content so edits made before this migration
     // continue to require confirmation. Only rewrite derived destination data.
     delete snapshot.project;
     snapshot.areaId=snapshot.projectId ? null : snapshot.areaId??null;
     update.run(JSON.stringify({...raw,successorSnapshot:JSON.stringify(snapshot)}),id);
    }
    db.exec('PRAGMA user_version=6');
   }
   db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_open_per_series ON tasks(json_extract(body, '$.seriesId')) WHERE json_extract(body, '$.seriesId') IS NOT NULL AND json_extract(body, '$.done') = 0;");
   db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
 } catch (error) { db.close(); throw error; }

 function list(): Task[] {
  const catalog=hydrationCatalog();
  return db.prepare('SELECT id, body FROM tasks ORDER BY id').all().map(row => hydrate({...JSON.parse(row.body as string), id: Number(row.id)},catalog));
 }
 function get(id: number): Task | undefined { const row = db.prepare('SELECT body FROM tasks WHERE id=?').get(id); return row ? hydrate({...JSON.parse(row.body as string), id}) : undefined; }
 function validate(input: unknown, partial = false): TaskPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskInputError('Dados da tarefa inválidos.');
  const value = input as Record<string, unknown>;
  const result: TaskPatch = {};
  if (!partial || 'title' in value) {
   if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500) throw new TaskInputError('Informe um título de até 500 caracteres.');
   result.title = capitalizeInitial(value.title.trim());
  }
  for (const field of ['notes','project','when'] as const) if (field in value) {
   if (typeof value[field] !== 'string' || value[field].length > 20000) throw new TaskInputError('Texto inválido.');
   result[field] = field === 'notes' ? capitalizeLines(value[field]) : value[field];
  }
  for (const field of ['plannedDate','deadline'] as const) if (field in value) {
   if (value[field] !== null && !validDate(value[field])) throw new TaskInputError('Informe uma data válida.');
   result[field] = value[field] as string | null;
  }
  if ('done' in value) {
   if (typeof value.done !== 'boolean') throw new TaskInputError('Estado inválido.');
   result.done = value.done;
  }
  if ('checklist' in value) {
   if (!Array.isArray(value.checklist) || value.checklist.length > 200 || value.checklist.some(c => !c || typeof c.text !== 'string' || c.text.length > 1000 || typeof c.done !== 'boolean')) throw new TaskInputError('Checklist inválido.');
   result.checklist = value.checklist.map(c => ({text: capitalizeInitial(c.text), done: c.done}));
  }
  if ('recurrence' in value) {
   if (value.recurrence !== null && value.recurrence !== 'daily' && value.recurrence !== 'weekly' && value.recurrence !== 'monthly') throw new TaskInputError('Escolha Sem repetição, Diária, Semanal ou Mensal.');
   result.recurrence = value.recurrence;
  }
  for (const field of ['areaId','projectId'] as const) if (field in value) {
   if (value[field] !== null && (!Number.isSafeInteger(value[field]) || Number(value[field]) < 1)) throw new TaskInputError('Área ou projeto inválido.');
   result[field] = value[field] as number | null;
  }
  return result;
 }

 function areaRows(): Area[] { return db.prepare('SELECT id,name FROM areas ORDER BY name COLLATE NOCASE,id').all() as Area[]; }
 function projectRows(): Project[] { return db.prepare('SELECT p.id,p.area_id AS areaId,a.name AS areaName,p.name,p.status,p.completed_at AS completedAt FROM projects p JOIN areas a ON a.id=p.area_id ORDER BY a.name COLLATE NOCASE,p.name COLLATE NOCASE,p.id').all() as Project[]; }
 function hydrationCatalog() { return {areas:new Map(areaRows().map(area=>[area.id,area])),projects:new Map(projectRows().map(project=>[project.id,project]))}; }
 function hydrate(task: Task,catalog=hydrationCatalog()): Task {
  const project = task.projectId ? catalog.projects.get(task.projectId) : undefined;
  const areaId = project?.areaId ?? task.areaId ?? null;
  const area = areaId===null ? undefined : catalog.areas.get(areaId);
  return {...task, areaId, projectId:project?.id ?? null, areaName:area?.name, projectName:project?.name, project:project ? `${project.areaName} · ${project.name}` : area?.name ?? ''};
 }
 function applyDestination(task: Task, patch: TaskPatch): Task {
  if ('project' in patch && !('areaId' in patch) && !('projectId' in patch)) {
   const label = patch.project?.trim() || '';
   if (!label) { task.areaId=null; task.projectId=null; }
   else {
    const project = projectRows().find(item => `${item.areaName} · ${item.name}` === label || item.name === label);
    const area = areaRows().find(item => item.name === label);
    if (project) { task.areaId=project.areaId; task.projectId=project.id; }
    else if (area) { task.areaId=area.id; task.projectId=null; }
   }
  }
  if ('areaId' in patch || 'projectId' in patch) {
   const projectId = patch.projectId === undefined ? task.projectId ?? null : patch.projectId;
   const areaId = patch.areaId === undefined ? task.areaId ?? null : patch.areaId;
   if (projectId !== null) {
    const project = projectRows().find(item => item.id === projectId);
    if (!project) throw new TaskInputError('Projeto não encontrado.');
    if (areaId !== null && areaId !== project.areaId) throw new TaskInputError('O projeto não pertence à área selecionada.');
    task.areaId=project.areaId; task.projectId=project.id;
   } else {
    if (areaId !== null && !areaRows().some(item=>item.id===areaId)) throw new TaskInputError('Área não encontrada.');
    task.areaId=areaId; task.projectId=null;
   }
  }
  return task;
 }

 function applyPatch(previous: Task, patch: TaskPatch): Task {
  const task: Task = {...previous, ...patch};
  if (patch.when !== undefined && patch.plannedDate === undefined) task.plannedDate=legacyDate(patch.when,localDay(now()));
  if (patch.plannedDate) task.when='Planejada';
  if (patch.plannedDate === null && task.when!=='Algum dia') task.when='Caixa de entrada';
  if (patch.when==='Algum dia') task.plannedDate=null;
  if ((patch.recurrence==='weekly'||patch.recurrence==='monthly') && previous.recurrence!==patch.recurrence) task.recurrenceAnchor=task.plannedDate||localDay(now());
  if ((previous.recurrence==='weekly'||previous.recurrence==='monthly') && patch.plannedDate!==undefined && patch.plannedDate!==previous.plannedDate) task.recurrenceAnchor=patch.plannedDate||localDay(now());
  if (patch.recurrence===null || patch.recurrence==='daily') delete task.recurrenceAnchor;
  if (patch.recurrence) {
   task.seriesId = task.seriesId ?? task.id;
   task.occurrence = task.occurrence ?? 1;
  }
  if (patch.done === false) delete task.completed;
  return applyDestination(task,patch);
 }

 function complete(id: number, changes: TaskPatch = {}): Task[] | undefined {
  db.exec('BEGIN IMMEDIATE');
  try {
   const task = get(id);
   if (!task) { db.exec('COMMIT'); return undefined; }
   if (task.done) { db.exec('COMMIT'); return list(); }
   const completedAt = now().toISOString();
   const contentChanges = {...changes}; delete contentChanges.done;
   const doneTask: Task = {...applyPatch(task, contentChanges), done:true, completed:completedAt};
   if (doneTask.recurrence === 'daily' || doneTask.recurrence === 'weekly' || doneTask.recurrence === 'monthly') {
    const completedDay = localDay(new Date(completedAt));
    const baseDay = doneTask.plannedDate && doneTask.plannedDate > completedDay ? doneTask.plannedDate : completedDay;
    const anchor=doneTask.recurrenceAnchor||doneTask.plannedDate||completedDay;
    const plannedDate = doneTask.recurrence==='daily' ? addDays(baseDay,1) : doneTask.recurrence==='weekly' ? weeklyNext(anchor,baseDay) : monthlyNext(anchor,baseDay);
    const previousBase = doneTask.plannedDate || completedDay;
    const deadline = doneTask.deadline ? addDays(plannedDate, dayDistance(previousBase, doneTask.deadline)) : null;
    const next: Omit<Task, 'id'> = {
     title:doneTask.title, project:doneTask.project, when:'Planejada', plannedDate, deadline,
     notes:doneTask.notes, checklist:doneTask.checklist.map(item=>({...item, done:false})), done:false,
     recurrence:doneTask.recurrence, ...(doneTask.recurrenceAnchor?{recurrenceAnchor:doneTask.recurrenceAnchor}:{}), areaId:doneTask.areaId??null, projectId:doneTask.projectId??null, seriesId:doneTask.seriesId ?? doneTask.id,
     occurrence:(doneTask.occurrence ?? 1)+1, previousId:doneTask.id,
    };
    // Free the unique open-series slot before inserting its successor, in this transaction.
    db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(doneTask), id);
    const insert = db.prepare('INSERT INTO tasks(body) VALUES (?)').run(JSON.stringify(next));
    const successorId = Number(insert.lastInsertRowid);
    const successor = {...next, id:successorId};
    const finished: Task = {...doneTask, seriesId:next.seriesId, occurrence:doneTask.occurrence ?? 1, successorId, successorSnapshot:contentSnapshot(successor)};
    db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(finished), id);
   } else {
    db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(doneTask), id);
   }
   db.exec('COMMIT');
   return list();
  } catch (error) { db.exec('ROLLBACK'); throw error; }
 }

 function reopen(id: number, confirmation?: ReopenConfirmation): Task[] | undefined {
  db.exec('BEGIN IMMEDIATE');
  try {
   const task = get(id);
   if (!task) { db.exec('COMMIT'); return undefined; }
   if (!task.done) { db.exec('COMMIT'); return list(); }
   if (task.successorId !== undefined) {
    const successor = get(task.successorId);
    const laterOccurrences = list().filter(candidate => candidate.seriesId === task.seriesId && (candidate.occurrence ?? 0) > (task.occurrence ?? 0));
    if (!successor) {
     if (laterOccurrences.length) throw new RecurrenceConflictError('completed-successor', 'Esta série tem uma ocorrência posterior. Reabra a conclusão mais recente da série.');
     // The open successor was deleted; with no later occurrence, the completed task is still the latest history.
    } else {
     if (successor.seriesId !== task.seriesId || successor.previousId !== task.id) throw new RecurrenceConflictError('completed-successor', 'A sequência de ocorrências mudou. Atualize a lista antes de reabrir.');
     if (successor.done || laterOccurrences.some(candidate=>candidate.id !== successor.id)) throw new RecurrenceConflictError('completed-successor', 'Esta ocorrência já tem uma sucessora concluída. Reabra a conclusão mais recente da série.');
     const successorFingerprint = contentSnapshot(successor);
     if (confirmation && confirmation.successorId !== successor.id) throw new RecurrenceConflictError('edited-successor', 'A próxima ocorrência mudou. Atualize a lista e tente novamente.', successor.id, successorFingerprint);
     if (successorFingerprint !== task.successorSnapshot && confirmation?.successorFingerprint !== successorFingerprint) {
      throw new RecurrenceConflictError('edited-successor', 'A próxima ocorrência foi editada. Confirme para substituí-la pelas alterações desta ocorrência.', successor.id, successorFingerprint);
     }
     db.prepare('DELETE FROM tasks WHERE id=?').run(successor.id);
    }
   } else if (confirmation !== undefined) {
    throw new RecurrenceConflictError('edited-successor', 'A próxima ocorrência já não existe. Atualize a lista antes de reabrir.');
   }
   const reopened: Task = {...task, done:false};
   delete reopened.completed; delete reopened.successorId; delete reopened.successorSnapshot;
   db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(reopened), id);
   db.exec('COMMIT');
   return list();
  } catch (error) { db.exec('ROLLBACK'); throw error; }
 }

 return {
  list,
  get,
  create(input: unknown): Task {
   const patch = validate(input);
   const task: Omit<Task, 'id'> = applyDestination({title:'', project:'', when:'Caixa de entrada', notes:'', checklist:[], deadline:null, ...patch, plannedDate:patch.plannedDate === undefined ? legacyDate(patch.when || '',localDay(now())) : patch.plannedDate, done:false} as Task,patch);
   if (task.when==='Algum dia') task.plannedDate=null;
   else if(task.plannedDate) task.when='Planejada';
   if ((task.recurrence==='weekly'||task.recurrence==='monthly')&&!task.recurrenceAnchor) task.recurrenceAnchor=task.plannedDate||localDay(now());
   db.exec('BEGIN IMMEDIATE');
   try {
    const result = db.prepare('INSERT INTO tasks (body) VALUES (?)').run(JSON.stringify(task));
    const id = Number(result.lastInsertRowid);
    const created: Task = {...task, id, ...(task.recurrence ? {seriesId:id, occurrence:1} : {})};
    db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(created), id);
    db.exec('COMMIT'); return hydrate(created);
   } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
  update(id: number, input: unknown): Task | undefined {
   const patch = validate(input, true);
   const current = get(id);
   if (!current) return undefined;
   if (current.done && current.seriesId !== undefined && Object.keys(patch).some(field=>field !== 'done')) {
    throw new RecurrenceConflictError('completed-history', 'Ocorrências concluídas da série são preservadas. Reabra a ocorrência antes de editar.');
   }
   if (patch.done === true) { const tasks = complete(id, patch); return tasks?.find(task=>task.id===id); }
   if (patch.done === false) {
    if (current.seriesId !== undefined) { const tasks = reopen(id); return tasks?.find(task=>task.id===id); }
   }
   db.exec('BEGIN IMMEDIATE');
   try {
    const previous = get(id);
    if (!previous) { db.exec('COMMIT'); return undefined; }
    const task = applyPatch(previous, patch);
    db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(task), id);
    db.exec('COMMIT'); return hydrate(task);
   } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
  complete,
  reopen,
  reorder(input: unknown): Task[] {
   if (!Array.isArray(input) || input.some(id=>!Number.isSafeInteger(id)) || new Set(input).size!==input.length) throw new TaskInputError('Ordem inválida.');
   db.exec('BEGIN IMMEDIATE');
   try {
    const rows=todayTasks(list(),localDay(now()));
    if (rows.length!==input.length || rows.some(t=>!input.includes(t.id))) throw new TaskInputError('A lista de Hoje mudou. Recarregue antes de ordenar.');
    const update=db.prepare('UPDATE tasks SET body=? WHERE id=?');
    input.forEach((id,index)=>{const task=rows.find(t=>t.id===id)!;update.run(JSON.stringify({...task,position:index}),id);});
    db.exec('COMMIT'); return list();
   } catch(error) {db.exec('ROLLBACK');throw error;}
  },
  areas: areaRows,
  projects: projectRows,
  createArea(input: unknown): Area {
   if (!input || typeof input !== 'object' || typeof (input as any).name !== 'string') throw new TaskInputError('Informe o nome da área.');
   const name=capitalizeInitial((input as any).name.trim()); if (!name || name.length>120) throw new TaskInputError('Informe um nome de área com até 120 caracteres.');
   try { const result=db.prepare('INSERT INTO areas(name) VALUES (?)').run(name); return {id:Number(result.lastInsertRowid),name}; }
   catch { throw new TaskInputError('Já existe uma área com esse nome.'); }
  },
  updateArea(id: number,input: unknown): Area | undefined {
   if (!input || typeof input !== 'object' || typeof (input as any).name !== 'string') throw new TaskInputError('Informe o nome da área.');
   const name=capitalizeInitial((input as any).name.trim()); if (!name || name.length>120) throw new TaskInputError('Informe um nome de área com até 120 caracteres.');
   if (!areaRows().some(area=>area.id===id)) return undefined;
   try { db.prepare('UPDATE areas SET name=? WHERE id=?').run(name,id); return {id,name}; }
   catch { throw new TaskInputError('Já existe uma área com esse nome.'); }
  },
  createProject(input: unknown): Project {
   if (!input || typeof input !== 'object' || typeof (input as any).name !== 'string' || !Number.isSafeInteger((input as any).areaId)) throw new TaskInputError('Informe o nome do projeto e sua área.');
   const name=capitalizeInitial((input as any).name.trim()); const areaId=Number((input as any).areaId);
   if (!name || name.length>120) throw new TaskInputError('Informe um nome de projeto com até 120 caracteres.');
   const area=areaRows().find(item=>item.id===areaId); if (!area) throw new TaskInputError('Área não encontrada.');
   try { const result=db.prepare('INSERT INTO projects(area_id,name) VALUES (?,?)').run(areaId,name); return {id:Number(result.lastInsertRowid),areaId,areaName:area.name,name,status:'open'}; }
   catch { throw new TaskInputError('Já existe um projeto com esse nome nesta área.'); }
  },
  updateProject(id: number,input: unknown): Project | undefined {
   if (!input || typeof input !== 'object') throw new TaskInputError('Dados do projeto inválidos.');
   const value=input as Record<string,unknown>; const current=projectRows().find(item=>item.id===id); if (!current) return undefined;
   const name=value.name===undefined ? current.name : typeof value.name==='string' ? capitalizeInitial(value.name.trim()) : '';
   const areaId=value.areaId===undefined ? current.areaId : Number(value.areaId);
   if (!name || name.length>120 || !Number.isSafeInteger(areaId)) throw new TaskInputError('Informe um nome de projeto e sua área.');
   if (!areaRows().some(item=>item.id===areaId)) throw new TaskInputError('Área não encontrada.');
   try { db.prepare('UPDATE projects SET name=?,area_id=? WHERE id=?').run(name,areaId,id); return projectRows().find(item=>item.id===id); }
   catch { throw new TaskInputError('Já existe um projeto com esse nome nesta área.'); }
  },
  setProjectStatus(id: number,status: unknown): Project | undefined {
   if (status!=='open' && status!=='completed') throw new TaskInputError('Estado do projeto inválido.');
   const current=projectRows().find(item=>item.id===id); if (!current) return undefined;
   if (status==='completed') {
    const openTasks=db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE json_extract(body,'$.projectId')=? AND json_extract(body,'$.done')=0").get(id) as {count:number};
    if (Number(openTasks.count)>0) throw new TaskInputError('Conclua todas as tarefas do projeto antes de concluir o projeto.');
   }
   db.prepare('UPDATE projects SET status=?,completed_at=? WHERE id=?').run(status,status==='completed'?now().toISOString():null,id);
   return projectRows().find(item=>item.id===id);
  },
  remove(id: number): boolean { return db.prepare('DELETE FROM tasks WHERE id=?').run(id).changes > 0; },
  close() { db.close(); },
 };
}
