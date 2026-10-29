import { localDay, legacyDate, validDate, addDays, todayTasks } from './task-dates.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { seed, type Task } from './tasks.ts';
import { capitalizeInitial, capitalizeLines } from './text.ts';
import { validateRecurrenceRule, nextCalendarDate, nextAfterCompletion, type RecurrenceRule } from './recurrence.ts';

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
export type { Task } from './tasks.ts';
type StoreOptions = { now?: () => Date };
type TaskPatch = Partial<Omit<Task, 'id' | 'seriesId' | 'occurrence' | 'previousId' | 'successorId' | 'successorSnapshot' | 'sourceId' | 'createdAt' | 'updatedAt' | 'effectiveTagIds' | 'scheduleId' | 'scheduledFor'>>;
export type Area = { id: number; name: string; tagIds: number[]; position:number; sourceId?:string };
export type Project = { id: number; areaId: number | null; areaName: string | null; name: string; status: 'open' | 'completed'; completedAt?: string; notes: string; plannedDate: string | null; deadline: string | null; position: number; tagIds: number[]; sourceId?:string };
export type Tag = { id: number; name: string; parentId: number | null; shortcut: string | null; position:number; sourceId?:string };
export type Heading = { id: number; projectId: number; title: string; position: number; sourceId?:string };
export type RecurringSchedule = {
 id: number; title: string; notes: string; checklist: {text:string;done:boolean}[];
 areaId: number | null; projectId: number | null; headingId: number | null; tagIds: number[];
 deadlineOffset: number | null; reminderTime: string | null; rule: RecurrenceRule;
 nextOccurrenceDate: string | null; sourceId?: string;
};
type ScheduleInput = Omit<RecurringSchedule, 'id'>;

function parseIds(value: unknown): number[] {
 try { const ids=JSON.parse(String(value??'[]')); return Array.isArray(ids)?ids.filter((id:unknown)=>Number.isSafeInteger(id)&&Number(id)>0):[]; }
 catch { return []; }
}
function validateIdList(value: unknown,label: string): number[] {
 if(!Array.isArray(value)||value.length>100||value.some(id=>!Number.isSafeInteger(id)||Number(id)<1)||new Set(value).size!==value.length) throw new TaskInputError(`${label} inválidas.`);
 return value as number[];
}
function snapshotObject(task:Task):Record<string,unknown>{
 return {
  title:task.title,when:task.when,
  plannedDate:task.plannedDate??null,deadline:task.deadline??null,
  notes:task.notes,checklist:task.checklist,
  reminderAt:task.reminderAt??null,tagIds:[...(task.tagIds??[])].sort((a,b)=>a-b),headingId:task.headingId??null,
  recurrence:task.recurrence??null,recurrenceAnchor:task.recurrenceAnchor??null,
  areaId:task.projectId?null:task.areaId??null,projectId:task.projectId??null,
 };
}
function normalizeSavedSnapshot(saved:Record<string,unknown>,task:Task):string{
 const defaults=snapshotObject(task);
 const merged={...defaults,...saved};
 return JSON.stringify({
  title:merged.title,when:merged.when,plannedDate:merged.plannedDate,deadline:merged.deadline,
  notes:merged.notes,checklist:merged.checklist,reminderAt:merged.reminderAt,
  tagIds:Array.isArray(merged.tagIds)?[...merged.tagIds].sort((a,b)=>Number(a)-Number(b)):[],headingId:merged.headingId,
  recurrence:merged.recurrence,recurrenceAnchor:merged.recurrenceAnchor,areaId:merged.areaId,projectId:merged.projectId,
 });
}
function contentSnapshot(task: Task): string {
 // Organization names and a project's parent area are derived labels. A project
 // move must not look like a direct edit to every task assigned to that project.
 return JSON.stringify(snapshotObject(task));
}
function dayDistance(from: string, to: string): number {
 return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}
function shiftReminderAt(reminderAt:string|null|undefined,fromDay:string,toDay:string):string|null{
 if(!reminderAt)return null;
 const date=new Date(reminderAt);if(Number.isNaN(date.getTime()))return reminderAt;
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Belem',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
 const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(value=>value.type===type)?.value??'00';
 const shiftedDay=addDays(localDay(date),dayDistance(fromDay,toDay));
 const milliseconds=date.getUTCMilliseconds();const fraction=milliseconds?`.${String(milliseconds).padStart(3,'0')}`:'';
 return new Date(`${shiftedDay}T${part('hour')}:${part('minute')}:${part('second')}${fraction}-03:00`).toISOString();
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
function isEligibleWeekday(recurrence: 'weekdays' | 'weekends', date: string): boolean {
 const weekday=new Date(`${date}T12:00:00Z`).getUTCDay();
 return recurrence==='weekdays' ? weekday>=1&&weekday<=5 : weekday===0||weekday===6;
}
function normalizeWeekdayDate(recurrence: 'weekdays' | 'weekends', date: string): string {
 let candidate=date;
 while(!isEligibleWeekday(recurrence,candidate))candidate=addDays(candidate,1);
 return candidate;
}
function nextWeekdayOccurrence(recurrence: 'weekdays' | 'weekends', after: string): string {
 return normalizeWeekdayDate(recurrence,addDays(after,1));
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
   if (version < 7) {
    // Expand organization metadata while retaining every existing record and ID.
    db.exec(`ALTER TABLE areas ADD COLUMN tag_ids TEXT NOT NULL DEFAULT '[]'; ALTER TABLE areas ADD COLUMN position INTEGER NOT NULL DEFAULT 0; ALTER TABLE areas ADD COLUMN source_id TEXT;
      CREATE UNIQUE INDEX areas_source_id ON areas(source_id) WHERE source_id IS NOT NULL;
      CREATE TABLE projects_v7 (id INTEGER PRIMARY KEY AUTOINCREMENT, area_id INTEGER REFERENCES areas(id), name TEXT NOT NULL COLLATE NOCASE, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')), completed_at TEXT, notes TEXT NOT NULL DEFAULT '', planned_date TEXT, deadline TEXT, position INTEGER NOT NULL DEFAULT 0, tag_ids TEXT NOT NULL DEFAULT '[]', source_id TEXT UNIQUE);
      INSERT INTO projects_v7(id,area_id,name,status,completed_at,position) SELECT id,area_id,name,status,completed_at,id FROM projects;
      DROP TABLE projects; ALTER TABLE projects_v7 RENAME TO projects;
      CREATE UNIQUE INDEX projects_area_name ON projects(COALESCE(area_id,0),name COLLATE NOCASE);
      CREATE TABLE headings (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_id TEXT UNIQUE);
      CREATE INDEX headings_project_position ON headings(project_id,position,id);
      CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL, shortcut TEXT, position INTEGER NOT NULL DEFAULT 0, source_id TEXT UNIQUE);
      CREATE UNIQUE INDEX tags_shortcut ON tags(shortcut COLLATE NOCASE) WHERE shortcut IS NOT NULL;
      CREATE TABLE recurring_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, next_occurrence_date TEXT);
      CREATE TABLE schedule_materializer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE UNIQUE INDEX tasks_schedule_occurrence ON tasks(json_extract(body,'$.scheduleId'),json_extract(body,'$.scheduledFor')) WHERE json_extract(body,'$.scheduleId') IS NOT NULL AND json_extract(body,'$.scheduledFor') IS NOT NULL;
      CREATE INDEX tasks_heading_id ON tasks(json_extract(body,'$.headingId'));`);
    const taskRows=db.prepare('SELECT id,body FROM tasks').all();
    const writeTask=db.prepare('UPDATE tasks SET body=? WHERE id=?');
    const migrationNow=now().toISOString();
    for(const row of taskRows){
     const task=JSON.parse(row.body as string) as Task;
     const next={...task,tagIds:Array.isArray(task.tagIds)?task.tagIds:[],reminderAt:task.reminderAt??null,headingId:task.headingId??null,createdAt:task.createdAt??migrationNow,updatedAt:task.updatedAt??migrationNow,scheduleId:task.scheduleId??null,scheduledFor:task.scheduledFor??null};
     writeTask.run(JSON.stringify(next),Number(row.id));
    }
    // Add newly fingerprinted fields to legacy saved baselines. Existing values
    // remain untouched so prior edits still trigger the same confirmation.
    const snapshotRows=db.prepare('SELECT id,body FROM tasks WHERE json_extract(body,\'$.successorSnapshot\') IS NOT NULL').all();
    for(const row of snapshotRows){
     const task=JSON.parse(row.body as string) as Task;
     let snapshot:Record<string,unknown>={}; try { const parsed=JSON.parse(task.successorSnapshot||'{}');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))snapshot=parsed;else throw new Error('invalid snapshot'); } catch { /* Leave a conservative empty baseline. */ }
     writeTask.run(JSON.stringify({...task,successorSnapshot:normalizeSavedSnapshot(snapshot,task)}),Number(row.id));
    }
    db.exec('PRAGMA user_version=7');
   }
   db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_open_per_series ON tasks(json_extract(body, '$.seriesId')) WHERE json_extract(body, '$.seriesId') IS NOT NULL AND json_extract(body, '$.done') = 0;");
   db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_source_id ON tasks(json_extract(body,'$.sourceId')) WHERE json_extract(body,'$.sourceId') IS NOT NULL AND json_extract(body,'$.sourceId')<>'';");
   db.exec("CREATE UNIQUE INDEX IF NOT EXISTS recurring_schedules_source_id ON recurring_schedules(json_extract(body,'$.sourceId')) WHERE json_extract(body,'$.sourceId') IS NOT NULL AND json_extract(body,'$.sourceId')<>'';");
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
  if ('reminderAt' in value) {
   if(value.reminderAt!==null&&(typeof value.reminderAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.reminderAt)||Number.isNaN(Date.parse(value.reminderAt)))) throw new TaskInputError('Informe um lembrete ISO válido.');
   result.reminderAt=value.reminderAt as string|null;
  }
  if ('headingId' in value) {
   if(value.headingId!==null&&(!Number.isSafeInteger(value.headingId)||Number(value.headingId)<1)) throw new TaskInputError('Seção inválida.');
   result.headingId=value.headingId as number|null;
  }
  if ('tagIds' in value) result.tagIds=validateIdList(value.tagIds,'Etiquetas');
  if ('done' in value) {
   if (typeof value.done !== 'boolean') throw new TaskInputError('Estado inválido.');
   result.done = value.done;
  }
  if ('checklist' in value) {
   if (!Array.isArray(value.checklist) || value.checklist.length > 200 || value.checklist.some(c => !c || typeof c.text !== 'string' || c.text.length > 1000 || typeof c.done !== 'boolean')) throw new TaskInputError('Checklist inválido.');
   result.checklist = value.checklist.map(c => ({text: capitalizeInitial(c.text), done: c.done}));
  }
  if ('recurrence' in value) {
   if (value.recurrence !== null && value.recurrence !== 'daily' && value.recurrence !== 'weekdays' && value.recurrence !== 'weekends' && value.recurrence !== 'weekly' && value.recurrence !== 'monthly') throw new TaskInputError('Escolha uma opção de repetição válida.');
   result.recurrence = value.recurrence;
  }
  for (const field of ['areaId','projectId'] as const) if (field in value) {
   if (value[field] !== null && (!Number.isSafeInteger(value[field]) || Number(value[field]) < 1)) throw new TaskInputError('Área ou projeto inválido.');
   result[field] = value[field] as number | null;
  }
  return result;
 }

 function areaRows(): Area[] { return (db.prepare('SELECT id,name,tag_ids AS tagIds,position,source_id AS sourceId FROM areas ORDER BY position,name COLLATE NOCASE,id').all() as {id:number;name:string;tagIds:string;position:number;sourceId?:string}[]).map(row=>({...row,tagIds:parseIds(row.tagIds)})); }
 function projectRows(): Project[] { return (db.prepare('SELECT p.id,p.area_id AS areaId,a.name AS areaName,p.name,p.status,p.completed_at AS completedAt,p.notes,p.planned_date AS plannedDate,p.deadline,p.position,p.tag_ids AS tagIds,p.source_id AS sourceId FROM projects p LEFT JOIN areas a ON a.id=p.area_id ORDER BY COALESCE(a.name,\'\') COLLATE NOCASE,p.position,p.name COLLATE NOCASE,p.id').all() as (Omit<Project,'tagIds'> & {tagIds:string})[]).map(row=>({...row,tagIds:parseIds(row.tagIds)})); }
 function tags():Tag[]{return db.prepare('SELECT id,name,parent_id AS parentId,shortcut,position,source_id AS sourceId FROM tags ORDER BY position,name COLLATE NOCASE,id').all() as Tag[];}
 function headings(projectId?:number):Heading[]{
  if(projectId===undefined)return db.prepare('SELECT id,project_id AS projectId,title,position,source_id AS sourceId FROM headings ORDER BY project_id,position,id').all() as Heading[];
  return db.prepare('SELECT id,project_id AS projectId,title,position,source_id AS sourceId FROM headings WHERE project_id=? ORDER BY position,id').all(projectId) as Heading[];
 }
 function scheduleRows():RecurringSchedule[]{
  return (db.prepare('SELECT id,body,next_occurrence_date AS nextOccurrenceDate FROM recurring_schedules ORDER BY id').all() as {id:number;body:string;nextOccurrenceDate:string|null}[]).map(row=>({...JSON.parse(row.body) as Omit<RecurringSchedule,'id'|'nextOccurrenceDate'>,id:row.id,nextOccurrenceDate:row.nextOccurrenceDate}));
 }
 function validateSchedule(input:unknown):ScheduleInput{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TaskInputError('Agendamento inválido.');
  const value=input as Record<string,unknown>;const title=typeof value.title==='string'?capitalizeInitial(value.title.trim()):'';
  const notes=typeof value.notes==='string'?capitalizeLines(value.notes):'';
  if(!title||title.length>500||notes.length>20000)throw new TaskInputError('Informe um título e notas válidos.');
  if(!Array.isArray(value.checklist)||value.checklist.length>200||value.checklist.some(item=>!item||typeof item.text!=='string'||item.text.length>1000||typeof item.done!=='boolean'))throw new TaskInputError('Checklist inválido.');
  const checklist=value.checklist.map(item=>({text:capitalizeInitial(item.text),done:item.done}));
  const areaId=value.areaId===null||value.areaId===undefined?null:Number(value.areaId);const projectId=value.projectId===null||value.projectId===undefined?null:Number(value.projectId);
  if(areaId!==null&&!areaRows().some(area=>area.id===areaId))throw new TaskInputError('Área não encontrada.');
  const project=projectId===null?undefined:projectRows().find(item=>item.id===projectId);if(projectId!==null&&!project)throw new TaskInputError('Projeto não encontrado.');
  if(project&&areaId!==null&&project.areaId!==areaId)throw new TaskInputError('O projeto não pertence à área selecionada.');
  const resolvedAreaId=project?.areaId??areaId;
  const headingId=value.headingId===null||value.headingId===undefined?null:Number(value.headingId);
  if(headingId!==null&&(!projectId||!db.prepare('SELECT 1 FROM headings WHERE id=? AND project_id=?').get(headingId,projectId)))throw new TaskInputError('A seção não pertence ao projeto.');
  const tagIds=validateIdList(value.tagIds??[],'Etiquetas');if(tagIds.some(id=>!tags().some(tag=>tag.id===id)))throw new TaskInputError('Uma etiqueta não existe.');
  const deadlineOffset=value.deadlineOffset===null||value.deadlineOffset===undefined?null:Number(value.deadlineOffset);
  if(deadlineOffset!==null&&(!Number.isSafeInteger(deadlineOffset)||Math.abs(deadlineOffset)>36500))throw new TaskInputError('Deslocamento de prazo inválido.');
  const reminderTime=value.reminderTime===null||value.reminderTime===undefined||value.reminderTime===''?null:typeof value.reminderTime==='string'?value.reminderTime:undefined;
  if(reminderTime===undefined||reminderTime!==null&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime))throw new TaskInputError('Hora do lembrete inválida.');
  let rule:RecurrenceRule;try{rule=validateRecurrenceRule(value.rule);}catch{throw new TaskInputError('Revise o padrão e as datas da repetição.');}
  const nextOccurrenceDate=value.nextOccurrenceDate===null?null:value.nextOccurrenceDate===undefined?(rule.mode==='calendar'?nextCalendarDate(rule,rule.anchorDate,true):rule.anchorDate):value.nextOccurrenceDate;
  if(nextOccurrenceDate!==null&&(!validDate(nextOccurrenceDate)||nextOccurrenceDate<rule.anchorDate||rule.endDate&&nextOccurrenceDate>rule.endDate))throw new TaskInputError('Próxima ocorrência fora do intervalo da regra.');
  return {title,notes,checklist,areaId:resolvedAreaId,projectId,headingId,tagIds,deadlineOffset,reminderTime:reminderTime as string|null,rule,nextOccurrenceDate:nextOccurrenceDate as string|null};
 }
 function taskFromSchedule(schedule:RecurringSchedule,day:string,previousId?:number):Omit<Task,'id'>{
  const deadline=schedule.deadlineOffset===null?null:addDays(day,schedule.deadlineOffset);
  let reminderAt:string|null=null;if(schedule.reminderTime)reminderAt=new Date(`${day}T${schedule.reminderTime}:00-03:00`).toISOString();
  return {title:schedule.title,projectId:schedule.projectId,areaId:schedule.areaId,project:'',when:day<=localDay(now())?'Hoje':'Planejada',plannedDate:day,deadline,reminderAt,notes:schedule.notes,checklist:schedule.checklist.map(item=>({...item,done:false})),done:false,tagIds:schedule.tagIds,headingId:schedule.headingId,scheduleId:schedule.id,scheduledFor:day,...(previousId===undefined?{}:{previousId}),createdAt:now().toISOString(),updatedAt:now().toISOString()};
 }
 function insertScheduleTask(schedule:RecurringSchedule,day:string,previousId?:number):number{
  const result=db.prepare('INSERT INTO tasks(body) VALUES (?)').run(JSON.stringify(taskFromSchedule(schedule,day,previousId)));return Number(result.lastInsertRowid);
 }
 type HydrationCatalog={areas:Map<number,Area>;projects:Map<number,Project>;tagParents:Map<number,number|null>;headingProjects:Map<number,number>;tagAncestors:Map<number,number[]>};
 function hydrationCatalog():HydrationCatalog {
  const tagParents=new Map(tags().map(tag=>[tag.id,tag.parentId]));
  const tagAncestors=new Map<number,number[]>();
  for(const id of tagParents.keys()){
   const chain:number[]=[];let current:number|null|undefined=id;let guard=0;
   while(current!==null&&current!==undefined&&guard++<100){chain.push(current);current=tagParents.get(current);}
   tagAncestors.set(id,chain.reverse());
  }
  return {
   areas:new Map(areaRows().map(area=>[area.id,area])),
   projects:new Map(projectRows().map(project=>[project.id,project])),
   tagParents,tagAncestors,
   headingProjects:new Map(headings().map(heading=>[heading.id,heading.projectId])),
  };
 }
 function hydrate(task: Task,catalog:HydrationCatalog=hydrationCatalog()): Task {
  const project = task.projectId ? catalog.projects.get(task.projectId) : undefined;
  const areaId = project ? project.areaId : task.areaId ?? null;
  const area = areaId===null ? undefined : catalog.areas.get(areaId);
  const parentTagIds=[...(area?.tagIds??[]),...(project?.tagIds??[])];
  const effectiveTagIds:number[]=[];
  for(const id of [...parentTagIds,...(task.tagIds??[])])for(const ancestor of catalog.tagAncestors.get(id)??[id])if(!effectiveTagIds.includes(ancestor))effectiveTagIds.push(ancestor);
  const result={...task, areaId, projectId:project?.id ?? null, areaName:area?.name, projectName:project?.name, project:project ? `${project.areaName?`${project.areaName} · `:''}${project.name}` : area?.name ?? '',tagIds:task.tagIds??[],effectiveTagIds};
  if(task.headingId!==null&&task.headingId!==undefined&&catalog.headingProjects.get(task.headingId)!==task.projectId) result.headingId=null;
  return result;
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
  if (task.plannedDate && (task.recurrence==='weekdays'||task.recurrence==='weekends') && (patch.recurrence!==undefined||patch.plannedDate!==undefined||patch.when!==undefined)) {
   task.plannedDate=normalizeWeekdayDate(task.recurrence,task.plannedDate);
   if(patch.when!==undefined)task.when='Planejada';
  }
  if (patch.plannedDate) task.when='Planejada';
  if (patch.plannedDate === null && task.when!=='Algum dia') task.when='Caixa de entrada';
  if (patch.when==='Algum dia') task.plannedDate=null;
  if ((patch.recurrence==='weekly'||patch.recurrence==='monthly') && previous.recurrence!==patch.recurrence) task.recurrenceAnchor=task.plannedDate||localDay(now());
  if ((previous.recurrence==='weekly'||previous.recurrence==='monthly') && (patch.plannedDate!==undefined||patch.when!==undefined) && task.plannedDate!==previous.plannedDate) task.recurrenceAnchor=task.plannedDate||localDay(now());
  if (patch.recurrence!==undefined && patch.recurrence!=='weekly' && patch.recurrence!=='monthly') delete task.recurrenceAnchor;
  if (patch.recurrence) {
   task.seriesId = task.seriesId ?? task.id;
   task.occurrence = task.occurrence ?? 1;
  }
  if (patch.done === false) delete task.completed;
  applyDestination(task,patch);
  if(patch.headingId!==undefined&&patch.headingId!==null){
   if(!db.prepare('SELECT 1 FROM headings WHERE id=? AND project_id=?').get(patch.headingId,task.projectId??-1)) throw new TaskInputError('A seção não pertence ao projeto da tarefa.');
  } else if(task.headingId!==null&&task.headingId!==undefined&&!db.prepare('SELECT 1 FROM headings WHERE id=? AND project_id=?').get(task.headingId,task.projectId??-1)) {
   if(patch.headingId===null)task.headingId=null; else task.headingId=null;
  }
  const validTags=new Set(tags().map(tag=>tag.id));
  if((task.tagIds??[]).some(id=>!validTags.has(id)))throw new TaskInputError('Uma etiqueta não existe.');
  task.updatedAt=now().toISOString();
  return task;
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
   if (doneTask.recurrence === 'daily' || doneTask.recurrence === 'weekdays' || doneTask.recurrence === 'weekends' || doneTask.recurrence === 'weekly' || doneTask.recurrence === 'monthly') {
    const completedDay = localDay(new Date(completedAt));
    const baseDay = doneTask.plannedDate && doneTask.plannedDate > completedDay ? doneTask.plannedDate : completedDay;
    const anchor=doneTask.recurrenceAnchor||doneTask.plannedDate||completedDay;
    const plannedDate = doneTask.recurrence==='daily' ? addDays(baseDay,1) : doneTask.recurrence==='weekdays'||doneTask.recurrence==='weekends' ? nextWeekdayOccurrence(doneTask.recurrence,baseDay) : doneTask.recurrence==='weekly' ? weeklyNext(anchor,baseDay) : monthlyNext(anchor,baseDay);
    const previousBase = doneTask.plannedDate || completedDay;
    const deadline = doneTask.deadline ? addDays(plannedDate, dayDistance(previousBase, doneTask.deadline)) : null;
    const reminderAt=shiftReminderAt(doneTask.reminderAt,previousBase,plannedDate);
    const next: Omit<Task, 'id'> = {
     title:doneTask.title, project:doneTask.project, when:'Planejada', plannedDate, deadline,reminderAt,
     notes:doneTask.notes, checklist:doneTask.checklist.map(item=>({...item, done:false})), done:false,
     recurrence:doneTask.recurrence, ...(doneTask.recurrenceAnchor?{recurrenceAnchor:doneTask.recurrenceAnchor}:{}), areaId:doneTask.areaId??null, projectId:doneTask.projectId??null, seriesId:doneTask.seriesId ?? doneTask.id,
     occurrence:(doneTask.occurrence ?? 1)+1, previousId:doneTask.id,headingId:doneTask.headingId??null,tagIds:doneTask.tagIds??[],createdAt:completedAt,updatedAt:completedAt,scheduleId:null,scheduledFor:null,
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
    if(doneTask.scheduleId!==null&&doneTask.scheduleId!==undefined){
     const schedule=scheduleRows().find(item=>item.id===doneTask.scheduleId);
     if(schedule&&schedule.rule.mode==='after-completion'&&!schedule.rule.paused){
      const nextDate=nextAfterCompletion(schedule.rule,localDay(new Date(completedAt)));
      if(nextDate){
       const successorId=insertScheduleTask(schedule,nextDate,doneTask.id);const successor=get(successorId)!;
       const finished={...doneTask,successorId,successorSnapshot:contentSnapshot(successor)};
       db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(finished),id);
      }
     }
    }
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
    const allTasks=list();
    const laterOccurrences = task.scheduleId!==null&&task.scheduleId!==undefined
     ? allTasks.filter(candidate=>{
      if(candidate.scheduleId!==task.scheduleId||candidate.id===task.id)return false;
      let previousId=candidate.previousId;const visited=new Set<number>();
      while(previousId!==undefined&&!visited.has(previousId)){
       if(previousId===task.id)return true;
       visited.add(previousId);previousId=allTasks.find(item=>item.id===previousId)?.previousId;
      }
      return false;
     })
     : allTasks.filter(candidate => candidate.seriesId === task.seriesId && (candidate.occurrence ?? 0) > (task.occurrence ?? 0));
    if (!successor) {
     if (laterOccurrences.length) throw new RecurrenceConflictError('completed-successor', 'Esta série tem uma ocorrência posterior. Reabra a conclusão mais recente da série.');
     // The open successor was deleted; with no later occurrence, the completed task is still the latest history.
    } else {
     const linkedScheduleTask=task.scheduleId!==null&&task.scheduleId!==undefined;
     if (linkedScheduleTask
      ? successor.scheduleId!==task.scheduleId||successor.previousId!==task.id
      : successor.seriesId !== task.seriesId || successor.previousId !== task.id) throw new RecurrenceConflictError('completed-successor', 'A sequência de ocorrências mudou. Atualize a lista antes de reabrir.');
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
   const createdAt=now().toISOString();
   const task: Omit<Task, 'id'> = applyDestination({title:'', project:'', when:'Caixa de entrada', notes:'', checklist:[], deadline:null,reminderAt:null,tagIds:[],headingId:null,createdAt,updatedAt:createdAt,scheduleId:null,scheduledFor:null,...patch, plannedDate:patch.plannedDate === undefined ? legacyDate(patch.when || '',localDay(now())) : patch.plannedDate, done:false} as Task,patch);
   if(task.tagIds?.some(id=>!tags().some(tag=>tag.id===id)))throw new TaskInputError('Uma etiqueta não existe.');
   if(task.headingId!==null&&task.headingId!==undefined&&!db.prepare('SELECT 1 FROM headings WHERE id=? AND project_id=?').get(task.headingId,task.projectId??-1))throw new TaskInputError('A seção não pertence ao projeto da tarefa.');
   if (task.when==='Algum dia') task.plannedDate=null;
   else if(task.plannedDate) task.when='Planejada';
   if (task.plannedDate && (task.recurrence==='weekdays'||task.recurrence==='weekends')) task.plannedDate=normalizeWeekdayDate(task.recurrence,task.plannedDate);
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
   if (current.done && (current.seriesId !== undefined||current.scheduleId!==null&&current.scheduleId!==undefined) && Object.keys(patch).some(field=>field !== 'done')) {
    throw new RecurrenceConflictError('completed-history', 'Ocorrências concluídas da série são preservadas. Reabra a ocorrência antes de editar.');
   }
   if (patch.done === true) { const tasks = complete(id, patch); return tasks?.find(task=>task.id===id); }
   if (patch.done === false) {
    if (current.seriesId !== undefined||current.scheduleId!==null&&current.scheduleId!==undefined) { const tasks = reopen(id); return tasks?.find(task=>task.id===id); }
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
  schedules: scheduleRows,
  createSchedule(input:unknown):RecurringSchedule{
   const schedule=validateSchedule(input);
   db.exec('BEGIN IMMEDIATE');try{
    const result=db.prepare('INSERT INTO recurring_schedules(body,next_occurrence_date) VALUES (?,?)').run(JSON.stringify({...schedule,nextOccurrenceDate:undefined}),schedule.nextOccurrenceDate);
    const created:RecurringSchedule={...schedule,id:Number(result.lastInsertRowid)};db.prepare('UPDATE recurring_schedules SET body=? WHERE id=?').run(JSON.stringify(created),created.id);db.exec('COMMIT');return created;
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  updateSchedule(id:number,input:unknown):RecurringSchedule|undefined{
   const current=scheduleRows().find(schedule=>schedule.id===id);if(!current)return undefined;
   if(!input||typeof input!=='object'||Array.isArray(input))throw new TaskInputError('Agendamento inválido.');
   const value=input as Record<string,unknown>;
   const merged={...current,...value,rule:{...current.rule,...(value.rule&&typeof value.rule==='object'?value.rule as Record<string,unknown>:{})}};
   const schedule=validateSchedule(merged);
   db.exec('BEGIN IMMEDIATE');try{
    const hasOccurrences=Boolean(db.prepare("SELECT 1 FROM tasks WHERE json_extract(body,'$.scheduleId')=? LIMIT 1").get(id));
    const cursor=schedule.rule.mode==='after-completion'&&hasOccurrences?null:schedule.nextOccurrenceDate;
    const updated={...schedule,id,nextOccurrenceDate:cursor,...(current.sourceId?{sourceId:current.sourceId}:{})};db.prepare('UPDATE recurring_schedules SET body=?,next_occurrence_date=? WHERE id=?').run(JSON.stringify(updated),cursor,id);
    if(current.rule.mode==='after-completion'&&current.rule.paused&&!schedule.rule.paused){
     const occurrences=list().filter(task=>task.scheduleId===id);
     const hasOpen=occurrences.some(task=>!task.done);
     const latestCompleted=occurrences.filter(task=>task.done&&task.completed).sort((a,b)=>(b.completed??'').localeCompare(a.completed??''))[0];
     if(!hasOpen&&latestCompleted&&latestCompleted.successorId===undefined){
      const nextDate=nextAfterCompletion(schedule.rule,localDay(new Date(latestCompleted.completed!)));
      if(nextDate){const successorId=insertScheduleTask(updated,nextDate,latestCompleted.id);const successor=get(successorId)!;db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify({...latestCompleted,successorId,successorSnapshot:contentSnapshot(successor)}),latestCompleted.id);}
     }
    }
    db.exec('COMMIT');return updated;
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  removeSchedule(id:number):boolean{
   db.exec('BEGIN IMMEDIATE');try{
    if(!scheduleRows().some(schedule=>schedule.id===id)){db.exec('COMMIT');return false;}
    const rows=db.prepare("SELECT id,body FROM tasks WHERE json_extract(body,'$.scheduleId')=?").all(id);
    for(const row of rows){const task=JSON.parse(row.body as string) as Task;const updated={...task,scheduleId:null,scheduledFor:null};delete updated.successorId;delete updated.successorSnapshot;db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(updated),Number(row.id));}
    db.prepare('DELETE FROM recurring_schedules WHERE id=?').run(id);db.exec('COMMIT');return true;
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  materializeSchedules(throughDay=localDay(now())):{created:number;truncated:boolean}{
   if(!validDate(throughDay))throw new TaskInputError('Informe uma data válida para materializar os agendamentos.');
   db.exec('BEGIN IMMEDIATE');let created=0;let truncated=false;
   try{
    const active=scheduleRows().filter(schedule=>!schedule.rule.paused);
    const savedCursor=db.prepare("SELECT value FROM schedule_materializer_state WHERE key='last_schedule_id'").get() as {value:string}|undefined;
    const lastId=Number(savedCursor?.value??0);const start=active.findIndex(schedule=>schedule.id>lastId);
    const schedules=start<0?active:[...active.slice(start),...active.slice(0,start)];
    const quota=Math.max(1,Math.floor(100/Math.max(1,active.length)));
    const insert=db.prepare('INSERT OR IGNORE INTO tasks(body) VALUES (?)');let processed=0;let lastProcessedId=lastId;
    for(const schedule of schedules){
     if(processed>=100){truncated=true;break;}
     if(schedule.rule.mode==='after-completion'){
      const exists=db.prepare("SELECT 1 FROM tasks WHERE json_extract(body,'$.scheduleId')=? LIMIT 1").get(schedule.id);
      if(!exists){const first=schedule.nextOccurrenceDate??schedule.rule.anchorDate;const row=insert.run(JSON.stringify(taskFromSchedule(schedule,first)));if(row.changes)created++;processed++;lastProcessedId=schedule.id;db.prepare('UPDATE recurring_schedules SET next_occurrence_date=NULL WHERE id=?').run(schedule.id);}
      continue;
     }
     let cursor=schedule.nextOccurrenceDate;
     if(cursor===null)continue;
     let scheduleProcessed=0;let scheduleTruncated=false;
     while(cursor&&cursor<=throughDay){
      if(processed>=100||scheduleProcessed>=quota){scheduleTruncated=true;break;}
      const result=insert.run(JSON.stringify(taskFromSchedule(schedule,cursor)));if(result.changes)created++;
      const next=nextCalendarDate(schedule.rule,cursor,false);cursor=next;
      processed++;scheduleProcessed++;
     }
     if(cursor&&cursor>throughDay&&!scheduleTruncated){
      if(processed<100&&scheduleProcessed<quota){const result=insert.run(JSON.stringify(taskFromSchedule(schedule,cursor)));if(result.changes)created++;processed++;scheduleProcessed++;}
      else scheduleTruncated=true;
     }
     db.prepare('UPDATE recurring_schedules SET next_occurrence_date=? WHERE id=?').run(cursor,schedule.id);
     if(scheduleProcessed>0)lastProcessedId=schedule.id;
     if(scheduleTruncated)truncated=true;
    }
    if(lastProcessedId!==lastId)db.prepare("INSERT INTO schedule_materializer_state(key,value) VALUES ('last_schedule_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(lastProcessedId));
    db.exec('COMMIT');return{created,truncated};
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  tags,
  headings,
  createTag(input:unknown):Tag{
   if(!input||typeof input!=='object'||Array.isArray(input))throw new TaskInputError('Etiqueta inválida.');
   const value=input as Record<string,unknown>;const name=typeof value.name==='string'?capitalizeInitial(value.name.trim()):'';
   const position=value.position===undefined?tags().length:Number(value.position);
   const parentId=value.parentId===undefined||value.parentId===null?null:Number(value.parentId);
   const shortcut=value.shortcut===undefined||value.shortcut===null||value.shortcut===''?null:typeof value.shortcut==='string'?value.shortcut.trim():undefined;
   if(!name||name.length>80||!Number.isSafeInteger(position)||position<0||shortcut===undefined||(shortcut!==null&&(shortcut.length>4||!/^.{1,4}$/u.test(shortcut))))throw new TaskInputError('Informe um nome, posição e atalho válidos.');
   if(parentId!==null&&!tags().some(tag=>tag.id===parentId))throw new TaskInputError('Etiqueta superior não encontrada.');
   try{const result=db.prepare('INSERT INTO tags(name,parent_id,shortcut,position) VALUES (?,?,?,?)').run(name,parentId,shortcut,position);return tags().find(tag=>tag.id===Number(result.lastInsertRowid))!;}catch{throw new TaskInputError('O nome ou atalho já está em uso.');}
  },
  updateTag(id:number,input:unknown):Tag|undefined{
   const current=tags().find(tag=>tag.id===id);if(!current)return undefined;
   if(!input||typeof input!=='object'||Array.isArray(input))throw new TaskInputError('Etiqueta inválida.');
   const value=input as Record<string,unknown>;const name=value.name===undefined?current.name:typeof value.name==='string'?capitalizeInitial(value.name.trim()):'';
   const position=value.position===undefined?current.position:Number(value.position);
   const parentId=value.parentId===undefined?current.parentId:value.parentId===null?null:Number(value.parentId);
   const shortcut=value.shortcut===undefined?current.shortcut:value.shortcut===null||value.shortcut===''?null:typeof value.shortcut==='string'?value.shortcut.trim():undefined;
   if(!name||name.length>80||!Number.isSafeInteger(position)||position<0||shortcut===undefined||(shortcut!==null&&shortcut.length>4))throw new TaskInputError('Informe um nome, posição e atalho válidos.');
   if(parentId!==null&&(!Number.isSafeInteger(parentId)||parentId<1||!tags().some(tag=>tag.id===parentId)))throw new TaskInputError('Etiqueta superior não encontrada.');
   if(parentId===id)throw new TaskInputError('Uma etiqueta não pode ser superior a si mesma.');
   let cursor=parentId;const seen=new Set([id]);while(cursor!==null){if(seen.has(cursor))throw new TaskInputError('Essa hierarquia criaria um ciclo.');seen.add(cursor);cursor=tags().find(tag=>tag.id===cursor)?.parentId??null;}
   try{db.prepare('UPDATE tags SET name=?,parent_id=?,shortcut=?,position=? WHERE id=?').run(name,parentId,shortcut,position,id);return tags().find(tag=>tag.id===id)!;}catch{throw new TaskInputError('O nome ou atalho já está em uso.');}
  },
  removeTag(id:number):boolean{
   if(!tags().some(tag=>tag.id===id))return false;
   db.exec('BEGIN IMMEDIATE');try{
    for(const table of ['areas','projects']){const rows=db.prepare(`SELECT id,tag_ids FROM ${table}`).all() as {id:number;tag_ids:string}[];for(const row of rows){const ids=parseIds(row.tag_ids).filter(value=>value!==id);if(ids.length!==parseIds(row.tag_ids).length)db.prepare(`UPDATE ${table} SET tag_ids=? WHERE id=?`).run(JSON.stringify(ids),row.id);}}
    const rows=db.prepare('SELECT id,body FROM tasks').all();for(const row of rows){const task=JSON.parse(row.body as string) as Task;let changed=false;const updated={...task};if(task.tagIds?.includes(id)){updated.tagIds=task.tagIds.filter(value=>value!==id);changed=true;}if(task.successorSnapshot){try{const snapshot=JSON.parse(task.successorSnapshot) as Record<string,unknown>;if(Array.isArray(snapshot.tagIds)&&snapshot.tagIds.includes(id)){snapshot.tagIds=snapshot.tagIds.filter(value=>value!==id);updated.successorSnapshot=normalizeSavedSnapshot(snapshot,task);changed=true;}}catch{/* Keep malformed snapshots conservative. */}}if(changed)db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(updated),Number(row.id));}
    const schedules=db.prepare('SELECT id,body FROM recurring_schedules').all();for(const row of schedules){const schedule=JSON.parse(row.body as string) as RecurringSchedule;if(schedule.tagIds.includes(id))db.prepare('UPDATE recurring_schedules SET body=? WHERE id=?').run(JSON.stringify({...schedule,tagIds:schedule.tagIds.filter(value=>value!==id)}),Number(row.id));}
    db.prepare('UPDATE tags SET parent_id=NULL WHERE parent_id=?').run(id);db.prepare('DELETE FROM tags WHERE id=?').run(id);db.exec('COMMIT');return true;
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  createHeading(input:unknown):Heading{
   const value=input as Record<string,unknown>;const projectId=Number(value?.projectId);const title=typeof value?.title==='string'?value.title.trim():'';
   if(!Number.isSafeInteger(projectId)||!projectRows().some(project=>project.id===projectId)||title.length>200)throw new TaskInputError('Informe um projeto e um título de até 200 caracteres.');
   const position=headings(projectId).length;const result=db.prepare('INSERT INTO headings(project_id,title,position) VALUES (?,?,?)').run(projectId,title,position);return{id:Number(result.lastInsertRowid),projectId,title,position};
  },
  updateHeading(id:number,input:unknown):Heading|undefined{
   const current=headings().find(heading=>heading.id===id);if(!current)return undefined;
   if(!input||typeof input!=='object'||Array.isArray(input))throw new TaskInputError('Seção inválida.');const value=input as Record<string,unknown>;
   if(value.title!==undefined){if(typeof value.title!=='string'||value.title.trim().length>200)throw new TaskInputError('Título inválido.');db.prepare('UPDATE headings SET title=? WHERE id=?').run(value.title.trim(),id);}
   return headings().find(heading=>heading.id===id);
  },
  removeHeading(id:number):boolean{
   const current=headings().find(heading=>heading.id===id);if(!current)return false;
   db.exec('BEGIN IMMEDIATE');try{
    const rows=db.prepare('SELECT id,body FROM tasks').all();
    for(const row of rows){
     const task=JSON.parse(row.body as string) as Task;const updated={...task};let changed=false;
     if(task.headingId===id){updated.headingId=null;updated.updatedAt=now().toISOString();changed=true;}
     if(task.successorSnapshot){try{const snapshot=JSON.parse(task.successorSnapshot) as Record<string,unknown>;if(snapshot.headingId===id){snapshot.headingId=null;updated.successorSnapshot=normalizeSavedSnapshot(snapshot,task);changed=true;}}catch{/* Keep malformed snapshots conservative. */}}
     if(changed)db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(updated),Number(row.id));
    }
    const schedules=db.prepare('SELECT id,body FROM recurring_schedules').all();for(const row of schedules){const schedule=JSON.parse(row.body as string) as RecurringSchedule;if(schedule.headingId===id)db.prepare('UPDATE recurring_schedules SET body=? WHERE id=?').run(JSON.stringify({...schedule,headingId:null}),Number(row.id));}
    db.prepare('DELETE FROM headings WHERE id=?').run(id);db.exec('COMMIT');return true;
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  reorderHeadings(projectId:number,input:unknown):Heading[]{
   if(!Number.isSafeInteger(projectId)||!Array.isArray(input)||input.some(id=>!Number.isSafeInteger(id))||new Set(input).size!==input.length)throw new TaskInputError('Ordem de seções inválida.');
   const rows=headings(projectId);if(rows.length!==input.length||rows.some(row=>!input.includes(row.id)))throw new TaskInputError('A lista de seções mudou. Recarregue antes de ordenar.');
   db.exec('BEGIN IMMEDIATE');try{const update=db.prepare('UPDATE headings SET position=? WHERE id=? AND project_id=?');input.forEach((id,index)=>update.run(index,id,projectId));db.exec('COMMIT');return headings(projectId);}catch(error){db.exec('ROLLBACK');throw error;}
  },
  createArea(input: unknown): Area {
   if (!input || typeof input !== 'object' || typeof (input as any).name !== 'string') throw new TaskInputError('Informe o nome da área.');
   const name=capitalizeInitial((input as any).name.trim()); if (!name || name.length>120) throw new TaskInputError('Informe um nome de área com até 120 caracteres.');
   const tagIds=validateIdList((input as any).tagIds??[],'Etiquetas');if(tagIds.some(id=>!tags().some(tag=>tag.id===id)))throw new TaskInputError('Uma etiqueta não existe.');
   const position=Number.isSafeInteger((input as any).position)?Number((input as any).position):areaRows().length;
   if(position<0)throw new TaskInputError('Posição inválida.');
   try { const result=db.prepare('INSERT INTO areas(name,tag_ids,position) VALUES (?,?,?)').run(name,JSON.stringify(tagIds),position); return {id:Number(result.lastInsertRowid),name,tagIds,position}; }
   catch { throw new TaskInputError('Já existe uma área com esse nome.'); }
  },
  updateArea(id: number,input: unknown): Area | undefined {
   if (!input || typeof input !== 'object' || typeof (input as any).name !== 'string') throw new TaskInputError('Informe o nome da área.');
   const name=capitalizeInitial((input as any).name.trim()); if (!name || name.length>120) throw new TaskInputError('Informe um nome de área com até 120 caracteres.');
   if (!areaRows().some(area=>area.id===id)) return undefined;
   const current=areaRows().find(area=>area.id===id)!;const tagIds=(input as any).tagIds===undefined?current.tagIds:validateIdList((input as any).tagIds,'Etiquetas');const position=(input as any).position===undefined?current.position:Number((input as any).position);if(!Number.isSafeInteger(position)||position<0)throw new TaskInputError('Posição inválida.');if(tagIds.some(tagId=>!tags().some(tag=>tag.id===tagId)))throw new TaskInputError('Uma etiqueta não existe.');
   try { db.prepare('UPDATE areas SET name=?,tag_ids=?,position=? WHERE id=?').run(name,JSON.stringify(tagIds),position,id); return areaRows().find(area=>area.id===id); }
   catch { throw new TaskInputError('Já existe uma área com esse nome.'); }
  },
  createProject(input: unknown): Project {
   if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as any).name !== 'string') throw new TaskInputError('Informe o nome do projeto.');
   const name=capitalizeInitial((input as any).name.trim()); const areaId=(input as any).areaId==null?null:Number((input as any).areaId);
   if (!name || name.length>120) throw new TaskInputError('Informe um nome de projeto com até 120 caracteres.');
   const area=areaId===null?undefined:areaRows().find(item=>item.id===areaId); if (areaId!==null&&!area) throw new TaskInputError('Área não encontrada.');
   const value=input as Record<string,unknown>;const notes=typeof value.notes==='string'?value.notes.trim():'';const plannedDate=value.plannedDate??null;const deadline=value.deadline??null;
   if(notes.length>20000||plannedDate!==null&&!validDate(plannedDate)||deadline!==null&&!validDate(deadline))throw new TaskInputError('Notas ou datas do projeto inválidas.');
   const position=Number.isSafeInteger(value.position)?Number(value.position):projectRows().filter(project=>project.areaId===areaId).length;
   const tagIds=validateIdList(value.tagIds??[],'Etiquetas');if(tagIds.some(id=>!tags().some(tag=>tag.id===id)))throw new TaskInputError('Uma etiqueta não existe.');
   try { const result=db.prepare('INSERT INTO projects(area_id,name,notes,planned_date,deadline,position,tag_ids) VALUES (?,?,?,?,?,?,?)').run(areaId,name,notes,plannedDate as string|null,deadline as string|null,position,JSON.stringify(tagIds)); return {id:Number(result.lastInsertRowid),areaId,areaName:area?.name??null,name,status:'open',notes,plannedDate:plannedDate as string|null,deadline:deadline as string|null,position,tagIds}; }
   catch { throw new TaskInputError('Já existe um projeto com esse nome nesta área.'); }
  },
  updateProject(id: number,input: unknown): Project | undefined {
   if (!input || typeof input !== 'object') throw new TaskInputError('Dados do projeto inválidos.');
   const value=input as Record<string,unknown>; const current=projectRows().find(item=>item.id===id); if (!current) return undefined;
   const name=value.name===undefined ? current.name : typeof value.name==='string' ? capitalizeInitial(value.name.trim()) : '';
   const areaId=value.areaId===undefined ? current.areaId : value.areaId===null?null:Number(value.areaId);
   if (!name || name.length>120 || areaId!==null&&!Number.isSafeInteger(areaId)) throw new TaskInputError('Informe um nome de projeto e sua área.');
   if (areaId!==null&&!areaRows().some(item=>item.id===areaId)) throw new TaskInputError('Área não encontrada.');
   const notes=value.notes===undefined?current.notes:typeof value.notes==='string'?value.notes.trim():'';
   const plannedDate=value.plannedDate===undefined?current.plannedDate:value.plannedDate;
   const deadline=value.deadline===undefined?current.deadline:value.deadline;
   const position=value.position===undefined?current.position:Number(value.position);
   const tagIds=value.tagIds===undefined?current.tagIds:validateIdList(value.tagIds,'Etiquetas');
   if(notes.length>20000||plannedDate!==null&&!validDate(plannedDate)||deadline!==null&&!validDate(deadline)||!Number.isSafeInteger(position)||tagIds.some(tagId=>!tags().some(tag=>tag.id===tagId)))throw new TaskInputError('Notas ou datas do projeto inválidas.');
   try { db.prepare('UPDATE projects SET name=?,area_id=?,notes=?,planned_date=?,deadline=?,position=?,tag_ids=? WHERE id=?').run(name,areaId,notes,plannedDate as string|null,deadline as string|null,position,JSON.stringify(tagIds),id); return projectRows().find(item=>item.id===id); }
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
