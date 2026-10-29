import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openTaskStore, RecurrenceConflictError } from '../lib/task-store.ts';

const fixedNow = () => new Date('2026-10-30T16:00:00.000Z');

function freshStore(path: string, now = fixedNow) {
 const store = openTaskStore(path, { now });
 for (const task of store.list()) store.remove(task.id);
 return store;
}

function makeDaily(store: ReturnType<typeof openTaskStore>, plannedDate = '2026-10-28') {
 const task = store.create({
  title: 'Enviar relatório diário', project: 'Operações', when: 'Planejada', plannedDate,
  notes: 'Enviar o resumo e registrar o retorno.',
  checklist: [{ text: 'Conferir dados', done: false }, { text: 'Enviar mensagem', done: false }],
 });
 return store.update(task.id, { recurrence: 'daily' } as never)!;
}

/** Rebuilds the v6 physical schema before setting a historical user_version. */
function downgradeV7Database(db:DatabaseSync,version:4|5){
 db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE;');
 try{
  db.exec(`DROP INDEX IF EXISTS tasks_schedule_occurrence;DROP INDEX IF EXISTS tasks_heading_id;
   DROP INDEX IF EXISTS headings_project_position;DROP INDEX IF EXISTS tags_shortcut;DROP INDEX IF EXISTS projects_area_name;DROP INDEX IF EXISTS areas_source_id;
   DROP TABLE IF EXISTS headings;DROP TABLE IF EXISTS tags;DROP TABLE IF EXISTS recurring_schedules;DROP TABLE IF EXISTS schedule_materializer_state;
   CREATE TABLE projects_legacy(id INTEGER PRIMARY KEY AUTOINCREMENT,area_id INTEGER NOT NULL REFERENCES areas(id),name TEXT NOT NULL COLLATE NOCASE,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),completed_at TEXT,UNIQUE(area_id,name));
   INSERT INTO projects_legacy(id,area_id,name,status,completed_at) SELECT id,area_id,name,status,completed_at FROM projects;
   DROP TABLE projects;ALTER TABLE projects_legacy RENAME TO projects;
   CREATE TABLE areas_legacy(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL COLLATE NOCASE UNIQUE);
   INSERT INTO areas_legacy(id,name) SELECT id,name FROM areas;
   DROP TABLE areas;ALTER TABLE areas_legacy RENAME TO areas;`);
  const rows=db.prepare('SELECT id,body FROM tasks').all() as {id:number;body:string}[];
  for(const row of rows){
   const task=JSON.parse(row.body) as Record<string,unknown>;
   for(const field of ['tagIds','effectiveTagIds','reminderAt','headingId','createdAt','updatedAt','scheduleId','scheduledFor','sourceId'])delete task[field];
   if(version===4)delete task.recurrenceAnchor;
   db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(task),row.id);
  }
  db.exec(`PRAGMA user_version=${version};COMMIT;PRAGMA foreign_keys=ON;`);
 }catch(error){db.exec('ROLLBACK;PRAGMA foreign_keys=ON;');throw error;}
}

test('completion skips missed days, resets checklist, persists, and is idempotent', () => {
 const directory = mkdtempSync(join(tmpdir(), 'painel-recurrence-'));
 const path = join(directory, 'test.sqlite');
 try {
  let store = freshStore(path);
  const first = makeDaily(store);
  store.update(first.id, { checklist: [{ text: 'Conferir dados', done: true }, { text: 'Enviar mensagem', done: true }] });
  const rows = store.complete(first.id)!;
  const completed = rows.find(task => task.id === first.id)!;
  const next = rows.find(task => task.id !== first.id)!;
  assert.equal(completed.done, true);
  assert.equal(next.plannedDate, '2026-10-31');
  assert.equal(next.title, first.title);
  assert.equal(next.notes, first.notes);
  assert.deepEqual(next.checklist, [{ text: 'Conferir dados', done: false }, { text: 'Enviar mensagem', done: false }]);
  assert.equal(rows.filter(task => task.plannedDate === '2026-10-31').length, 1);
  const count = rows.length;
  const repeated = store.complete(first.id)!;
  assert.equal(repeated.length, count);
  assert.equal(repeated.filter(task => task.plannedDate === '2026-10-31').length, 1);
  store.close();

  const script = `import {openTaskStore} from ${JSON.stringify(new URL('../lib/task-store.ts', import.meta.url).href)}; const s=openTaskStore(${JSON.stringify(path)}, {now:()=>new Date('2026-10-30T16:00:00.000Z')}); process.stdout.write(JSON.stringify(s.list())); s.close();`;
  const saved = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' }));
  const savedFirst = saved.find((task: { id: number }) => task.id === first.id);
  const savedNext = saved.find((task: { id: number }) => task.id === next.id);
  assert.equal(savedFirst.done, true);
  assert.equal(savedNext.plannedDate, '2026-10-31');
  assert.deepEqual(savedNext.checklist.map((item: { done: boolean }) => item.done), [false, false]);
  store = openTaskStore(path, { now: fixedNow });
  assert.equal(store.list().filter(task => task.recurrence === 'daily').length, 2);
  store.close();
 } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('reopening the last occurrence removes an untouched successor', () => {
 const directory = mkdtempSync(join(tmpdir(), 'painel-recurrence-reopen-'));
 const store = freshStore(join(directory, 'test.sqlite'));
 try {
  const first = makeDaily(store, '2026-10-30');
  const rows = store.complete(first.id)!;
  const successor = rows.find(task => task.id !== first.id)!;
  assert.equal(successor.plannedDate, '2026-10-31');
  const reopened = store.reopen(first.id)!;
  assert.equal(reopened.find(task => task.id === first.id)?.done, false);
  assert.equal(reopened.some(task => task.id === successor.id), false);
 } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('successor edits require explicit confirmation and preserve both versions beforehand', () => {
 const directory = mkdtempSync(join(tmpdir(), 'painel-recurrence-conflict-'));
 const store = freshStore(join(directory, 'test.sqlite'));
 try {
  const first = makeDaily(store, '2026-10-30');
  const successor = store.complete(first.id)!.find(task => task.id !== first.id)!;
  const original = store.list().find(task => task.id === first.id)!;
  store.update(successor.id, {
   title: 'Relatório adaptado', notes: 'Incluir observação especial.',
   checklist: [{ text: 'Conferir dados', done: true }, { text: 'Enviar mensagem', done: false }],
  });
  const edited = store.list().find(task => task.id === successor.id)!;
  let confirmation!: { successorId: number; successorFingerprint: string };
  assert.throws(() => store.reopen(first.id), (error: unknown) => {
   if (!(error instanceof RecurrenceConflictError) || error.code !== 'edited-successor') return false;
   confirmation = { successorId: error.successorId!, successorFingerprint: error.successorFingerprint! };
   return true;
  });
  assert.equal(store.list().find(task => task.id === first.id)?.done, true);
  assert.deepEqual(store.list().find(task => task.id === successor.id), edited);
  const history = store.list().find(task => task.id === first.id)!;
  assert.equal(history.title, original.title);
  assert.equal(history.notes, original.notes);
  assert.deepEqual(history.checklist, original.checklist);
  store.update(successor.id, { notes: 'Alteração mais recente durante a confirmação.' });
  assert.throws(() => store.reopen(first.id, confirmation), (error: unknown) => error instanceof RecurrenceConflictError && error.code === 'edited-successor');
  assert.equal(store.list().find(task => task.id === successor.id)?.notes, 'Alteração mais recente durante a confirmação.');
  assert.throws(() => store.reopen(first.id), (error: unknown) => {
   if (!(error instanceof RecurrenceConflictError) || error.code !== 'edited-successor') return false;
   confirmation = { successorId: error.successorId!, successorFingerprint: error.successorFingerprint! };
   return true;
  });
  const confirmed = store.reopen(first.id, confirmation)!;
  assert.equal(confirmed.find(task => task.id === first.id)?.done, false);
  assert.equal(confirmed.some(task => task.id === successor.id), false);
 } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('reopening an occurrence with a completed successor is rejected', () => {
 const directory = mkdtempSync(join(tmpdir(), 'painel-recurrence-ancestor-'));
 const store = freshStore(join(directory, 'test.sqlite'));
 try {
  const first = makeDaily(store, '2026-10-30');
  const next = store.complete(first.id)!.find(task => task.id !== first.id)!;
  store.complete(next.id);
  assert.throws(() => store.reopen(first.id), (error: unknown) => error instanceof RecurrenceConflictError && error.code === 'completed-successor');
  assert.equal(store.list().find(task => task.id === first.id)?.done, true);
  assert.equal(store.list().find(task => task.id === next.id)?.done, true);
 } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a completed occurrence is immutable through content patches but can be reopened', () => {
 const directory = mkdtempSync(join(tmpdir(), 'painel-recurrence-history-'));
 const store = freshStore(join(directory, 'test.sqlite'));
 try {
  const first = makeDaily(store, '2026-10-30');
  store.update(first.id, { checklist: [{ text: 'Conferir dados', done: true }, { text: 'Enviar mensagem', done: false }] });
  const completed = store.complete(first.id)!.find(task => task.id === first.id)!;
  assert.equal(completed.done, true);
  assert.throws(() => store.update(first.id, { title: 'Título alterado' }), (error: unknown) => error instanceof RecurrenceConflictError && error.code === 'completed-history');
  assert.throws(() => store.update(first.id, { notes: 'Notas alteradas' }), (error: unknown) => error instanceof RecurrenceConflictError && error.code === 'completed-history');
  assert.throws(() => store.update(first.id, { checklist: [{ text: 'Alterado', done: false }] }), (error: unknown) => error instanceof RecurrenceConflictError && error.code === 'completed-history');
  const afterRejectedEdits = store.list().find(task => task.id === first.id)!;
  assert.equal(afterRejectedEdits.title, completed.title);
  assert.equal(afterRejectedEdits.notes, completed.notes);
  assert.deepEqual(afterRejectedEdits.checklist, completed.checklist);

  const reopened = store.reopen(first.id)!;
  const reopenedFirst = reopened.find(task => task.id === first.id)!;
  assert.equal(reopenedFirst.done, false);
  assert.equal(reopenedFirst.title, completed.title);
  assert.equal(reopenedFirst.notes, completed.notes);
  assert.deepEqual(reopenedFirst.checklist, completed.checklist);
 } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('deleting a successor then reopening its predecessor does not duplicate the series', () => {
 const directory = mkdtempSync(join(tmpdir(), 'painel-recurrence-missing-successor-'));
 const store = freshStore(join(directory, 'test.sqlite'));
 try {
  const first = makeDaily(store, '2026-10-30');
  const successor = store.complete(first.id)!.find(task => task.id !== first.id)!;
  assert.equal(store.remove(successor.id), true);
  const reopened = store.reopen(first.id)!;
  assert.equal(reopened.find(task => task.id === first.id)?.done, false);
  assert.equal(reopened.filter(task => task.seriesId === first.seriesId).length, 1);
  const repeated = store.reopen(first.id)!;
  assert.equal(repeated.filter(task => task.seriesId === first.seriesId).length, 1);
 } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('disabling recurrence prevents another occurrence and daily migration does not duplicate seed task', () => {
 const directory = mkdtempSync(join(tmpdir(), 'painel-recurrence-migration-'));
 const path = join(directory, 'test.sqlite');
 try {
  const store = freshStore(path);
  const task = makeDaily(store, '2026-10-30');
  store.update(task.id, { recurrence: null } as never);
  const completed = store.complete(task.id)!;
  assert.equal(completed.filter(row => row.recurrence === 'daily').length, 0);
  assert.equal(completed.length, 1);
  store.close();

  const legacyPath = join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(legacyPath);
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL); PRAGMA user_version=2;');
  const legacy = { id: 11, title: 'Mandar promos e emissões', project: '', when: 'Hoje', done: false, notes: 'Nota existente', checklist: [], recurrence: 'daily', plannedDate: '2026-10-28', deadline: null, position: 11 };
  db.prepare('INSERT INTO tasks(id, body) VALUES (?, ?)').run(11, JSON.stringify(legacy));
  db.close();
  let migrated = openTaskStore(legacyPath, { now: fixedNow });
  const seedOccurrences = migrated.list().filter(row => row.id === 11);
  assert.equal(seedOccurrences.length, 1);
  assert.equal(seedOccurrences[0]?.recurrence, 'daily');
  assert.equal(seedOccurrences[0]?.seriesId, 11);
  assert.equal(seedOccurrences[0]?.occurrence, 1);
  assert.equal(seedOccurrences[0]?.notes, 'Nota existente');
  migrated.close();
  migrated = openTaskStore(legacyPath, { now: fixedNow });
  assert.equal(migrated.list().filter(row => row.seriesId === 11).length, 1);
  migrated.close();
 } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('weekly recurrence keeps its weekday anchor and reanchors when planned date changes',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-weekly-'));let clock=new Date('2026-01-10T16:00:00.000Z');const store=openTaskStore(join(directory,'test.sqlite'),{now:()=>clock});
 try{
  for(const task of store.list())store.remove(task.id);
  const task=store.create({title:'Revisar semanalmente',when:'Planejada',plannedDate:'2026-01-05',recurrence:'weekly'});
  assert.equal(task.recurrenceAnchor,'2026-01-05');
  store.update(task.id,{plannedDate:'2026-01-06'});assert.equal(store.get(task.id)?.recurrenceAnchor,'2026-01-06');
  const next=store.complete(task.id)!.find(row=>row.id!==task.id)!;
  assert.equal(next.plannedDate,'2026-01-13');assert.equal(next.recurrenceAnchor,'2026-01-06');
  const missed=store.create({title:'Semanal após ausência',when:'Planejada',plannedDate:'2026-01-05',recurrence:'weekly'});clock=new Date('2026-02-01T16:00:00.000Z');const later=store.complete(missed.id)!.find(row=>row.id!==missed.id&&row.seriesId===missed.seriesId)!;assert.equal(later.plannedDate,'2026-02-02');
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('weekday and weekend recurrences normalize ineligible dates and skip missed periods',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-weekday-weekend-'));let clock=new Date('2026-01-02T16:00:00.000Z');const store=freshStore(join(directory,'test.sqlite'),()=>clock);
 try{
  const weekdays=store.create({title:'Tarefa de semana',when:'Planejada',plannedDate:'2026-01-02',recurrence:'weekdays'}); // Friday
  const fromThursday=store.create({title:'Outra tarefa de semana',when:'Planejada',plannedDate:'2026-01-01',recurrence:'weekdays'});
  assert.equal(fromThursday.plannedDate,'2026-01-01');
  const weekend=store.create({title:'Tarefa de fim de semana',when:'Planejada',plannedDate:'2026-01-02',recurrence:'weekends'}); // Friday rolls to Saturday
  assert.equal(weekend.plannedDate,'2026-01-03');
  const saturday=store.create({title:'Tarefa de segunda',when:'Planejada',plannedDate:'2026-01-03',recurrence:'weekdays'});
  assert.equal(saturday.plannedDate,'2026-01-05');
  const afterFriday=store.complete(weekdays.id)!.find(row=>row.id!==weekdays.id&&row.seriesId===weekdays.seriesId)!;
  assert.equal(afterFriday.plannedDate,'2026-01-05');
  const afterSaturday=store.complete(weekend.id)!.find(row=>row.id!==weekend.id&&row.seriesId===weekend.seriesId)!;
  assert.equal(afterSaturday.plannedDate,'2026-01-04');
  clock=new Date('2026-02-01T16:00:00.000Z');
  const missedWeekday=store.complete(fromThursday.id)!.find(row=>row.id!==fromThursday.id&&row.seriesId===fromThursday.seriesId)!;
  assert.equal(missedWeekday.plannedDate,'2026-02-02');
  const missedWeekend=store.create({title:'Fim de semana com atraso',when:'Planejada',plannedDate:'2026-01-03',recurrence:'weekends'});
  const later=store.complete(missedWeekend.id)!.find(row=>row.id!==missedWeekend.id&&row.seriesId===missedWeekend.seriesId)!;
  assert.equal(later.plannedDate,'2026-02-07');
  const future=store.create({title:'Série futura',when:'Planejada',plannedDate:'2026-02-09',recurrence:'weekdays'});
  const nextFuture=store.complete(future.id)!.find(row=>row.id!==future.id&&row.seriesId===future.seriesId)!;
  assert.equal(nextFuture.plannedDate,'2026-02-10');
  const edited=store.create({title:'Reancorar fim de semana',when:'Planejada',plannedDate:'2026-01-03',recurrence:'weekends'});
  store.update(edited.id,{plannedDate:'2026-01-08'});
  assert.equal(store.get(edited.id)?.plannedDate,'2026-01-10');
  const fromLegacyWhen=store.create({title:'Data por destino',when:'Planejada',plannedDate:'2026-01-02',recurrence:'weekdays'});
  store.update(fromLegacyWhen.id,{when:'Amanhã'});
  assert.equal(store.get(fromLegacyWhen.id)?.plannedDate,'2026-02-02');
  const weekly=store.create({title:'Troca de frequência',when:'Planejada',plannedDate:'2026-01-02',recurrence:'weekly'});
  assert.ok(store.get(weekly.id)?.recurrenceAnchor);
  store.update(weekly.id,{recurrence:'weekdays'});
  assert.equal(store.get(weekly.id)?.recurrenceAnchor,undefined);
  const reopenable=store.create({title:'Reabrir fim de semana',when:'Planejada',plannedDate:'2026-02-07',recurrence:'weekends'});
  const successor=store.complete(reopenable.id)!.find(row=>row.id!==reopenable.id&&row.seriesId===reopenable.seriesId)!;
  store.update(successor.id,{title:'Sucessora editada'});
  let confirmation!: {successorId:number;successorFingerprint:string};
  assert.throws(()=>store.reopen(reopenable.id),(error:unknown)=>{if(!(error instanceof RecurrenceConflictError)||error.code!=='edited-successor')return false;confirmation={successorId:error.successorId!,successorFingerprint:error.successorFingerprint!};return true;});
  const reopened=store.reopen(reopenable.id,confirmation)!;
  assert.equal(reopened.find(row=>row.id===reopenable.id)?.done,false);
  assert.equal(reopened.some(row=>row.id===successor.id),false);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('task validation accepts weekday/weekend recurrence values and rejects unknown values',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-recurrence-api-'));const path=join(directory,'test.sqlite');
 try{
  const store=freshStore(path);
  const weekdays=store.create({title:'Tarefa via API',when:'Planejada',plannedDate:'2026-01-02',recurrence:'weekdays'});
  const weekends=store.create({title:'Tarefa via API',when:'Planejada',plannedDate:'2026-01-03',recurrence:'weekends'});
  assert.equal(weekdays.recurrence,'weekdays');assert.equal(weekends.recurrence,'weekends');
  assert.throws(()=>store.create({title:'Repetição desconhecida',recurrence:'holidays'}),/opção de repetição válida/);
  store.close();
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('monthly recurrence clamps short months, restores anchor day, handles leap years, and skips missed periods',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-monthly-'));let clock=new Date('2026-01-31T16:00:00.000Z');const store=openTaskStore(join(directory,'test.sqlite'),{now:()=>clock});
 try{
  for(const task of store.list())store.remove(task.id);
  const task=store.create({title:'Fechamento mensal',when:'Planejada',plannedDate:'2026-01-31',recurrence:'monthly'});
  assert.equal(task.recurrenceAnchor,'2026-01-31');
  let rows=store.complete(task.id)!;let next=rows.find(row=>row.id!==task.id)!;assert.equal(next.plannedDate,'2026-02-28');
  clock=new Date('2026-02-28T16:00:00.000Z');rows=store.complete(next.id)!;next=rows.find(row=>row.id!==next.id&&row.done===false)!;assert.equal(next.plannedDate,'2026-03-31');
  const leap=store.create({title:'Fechamento bissexto',when:'Planejada',plannedDate:'2028-01-31',recurrence:'monthly'});
  clock=new Date('2028-01-31T16:00:00.000Z');rows=store.complete(leap.id)!;next=rows.find(row=>row.id!==leap.id&&row.seriesId===leap.seriesId)!;assert.equal(next.plannedDate,'2028-02-29');
  const missed=store.create({title:'Mensal com períodos perdidos',when:'Planejada',plannedDate:'2026-01-31',recurrence:'monthly'});
  clock=new Date('2026-05-03T16:00:00.000Z');rows=store.complete(missed.id)!;next=rows.find(row=>row.id!==missed.id&&row.seriesId===missed.seriesId)!;assert.equal(next.plannedDate,'2026-05-31');
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('periodic reopens retain confirmation protection for an edited successor',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-periodic-reopen-'));const store=openTaskStore(join(directory,'test.sqlite'),{now:()=>new Date('2026-01-31T16:00:00.000Z')});
 try{
  for(const task of store.list())store.remove(task.id);
  const first=store.create({title:'Fechamento mensal',when:'Planejada',plannedDate:'2026-01-31',recurrence:'monthly'});const successor=store.complete(first.id)!.find(task=>task.id!==first.id)!;
  assert.equal(successor.plannedDate,'2026-02-28');store.update(successor.id,{title:'Fechamento ajustado'});
  let confirmation!: {successorId:number;successorFingerprint:string};
  assert.throws(()=>store.reopen(first.id),(error:unknown)=>{if(!(error instanceof RecurrenceConflictError)||error.code!=='edited-successor')return false;confirmation={successorId:error.successorId!,successorFingerprint:error.successorFingerprint!};return true;});
  const reopened=store.reopen(first.id,confirmation)!;assert.equal(reopened.find(task=>task.id===first.id)?.done,false);assert.equal(reopened.some(task=>task.id===successor.id),false);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('organization renames and project moves do not create recurrence conflicts, but task edits still do',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-recurrence-organization-'));const store=freshStore(join(directory,'test.sqlite'));
 try{
  const area=store.createArea({name:'Operações'});const destination=store.createArea({name:'Equipe'});const project=store.createProject({name:'Fechamento',areaId:area.id});
  const first=store.create({title:'Revisar fechamento',when:'Planejada',plannedDate:'2026-01-31',recurrence:'monthly',areaId:area.id,projectId:project.id});
  const successor=store.complete(first.id)!.find(row=>row.id!==first.id)!;
  store.updateArea(area.id,{name:'Finanças'});store.updateProject(project.id,{name:'Fechamento mensal',areaId:destination.id});
  assert.equal(store.get(successor.id)?.project,'Equipe · Fechamento mensal');
  let reopened=store.reopen(first.id)!;
  assert.equal(reopened.find(row=>row.id===first.id)?.done,false);
  assert.equal(reopened.some(row=>row.id===successor.id),false);

  const second=store.create({title:'Revisar fechamento',when:'Planejada',plannedDate:'2026-02-28',recurrence:'monthly',areaId:destination.id,projectId:project.id});
  const edited=store.complete(second.id)!.find(row=>row.seriesId===second.seriesId&&row.id!==second.id)!;
  store.update(edited.id,{title:'Revisar fechamento com ajuste'});
  assert.throws(()=>store.reopen(second.id),(error:unknown)=>error instanceof RecurrenceConflictError&&error.code==='edited-successor');
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('migration refreshes daily successor fingerprints without changing existing series behavior',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-recurrence-v5-migration-'));const path=join(directory,'test.sqlite');let store=freshStore(path);
 try{
  const first=makeDaily(store,'2026-10-30');const successor=store.complete(first.id)!.find(task=>task.id!==first.id)!;const completed=store.list().find(task=>task.id===first.id)!;store.close();
  const db=new DatabaseSync(path);const oldSnapshot={title:successor.title,project:successor.project,when:successor.when,plannedDate:successor.plannedDate??null,deadline:successor.deadline??null,notes:successor.notes,checklist:successor.checklist,recurrence:successor.recurrence??null};
  db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify({...completed,successorSnapshot:JSON.stringify(oldSnapshot)}),first.id);downgradeV7Database(db,4);db.close();
  store=openTaskStore(path,{now:fixedNow});const reopened=store.reopen(first.id)!;assert.equal(reopened.find(task=>task.id===first.id)?.done,false);assert.equal(reopened.some(task=>task.id===successor.id),false);store.close();
 }finally{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});}
});

test('v4 weekly and monthly series migrate anchors and can reopen migrated successors',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-v4-periodic-migration-'));const path=join(directory,'test.sqlite');let store=freshStore(path);
 try{
  const series=['weekly','monthly'] as const;const predecessors:{id:number;recurrence:typeof series[number]}[]=[];
  for(const recurrence of series){const task=store.create({title:`Revisão ${recurrence}`,when:'Planejada',plannedDate:recurrence==='weekly'?'2026-01-05':'2026-01-31',recurrence});store.complete(task.id);predecessors.push({id:task.id,recurrence});}
  store.close();
  const db=new DatabaseSync(path);
  for(const {id,recurrence} of predecessors){
   const row=db.prepare('SELECT body FROM tasks WHERE id=?').get(id) as {body:string};const parent=JSON.parse(row.body);
   const successorRow=db.prepare('SELECT body FROM tasks WHERE id=?').get(parent.successorId) as {body:string};const successor=JSON.parse(successorRow.body);
   delete parent.recurrenceAnchor;delete successor.recurrenceAnchor;
   const old={title:successor.title,project:successor.project,when:successor.when,plannedDate:successor.plannedDate??null,deadline:successor.deadline??null,notes:successor.notes,checklist:successor.checklist,recurrence:successor.recurrence??null};
   parent.successorSnapshot=JSON.stringify(old);
   if(recurrence==='monthly')successor.title='Edição anterior à migração';
   db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(parent),id);
   db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(successor),parent.successorId);
  }
  downgradeV7Database(db,4);db.close();
  store=openTaskStore(path,{now:()=>new Date('2026-02-01T16:00:00.000Z')});
  for(const {id,recurrence} of predecessors){
   const parent=store.get(id)!;const successor=store.get(parent.successorId!)!;
   assert.ok(parent.recurrenceAnchor);assert.ok(successor.recurrenceAnchor);
   if(recurrence==='monthly'){
    assert.throws(()=>store.reopen(id),(error:unknown)=>error instanceof RecurrenceConflictError&&error.code==='edited-successor');
    assert.equal(store.get(successor.id)?.title,'Edição anterior à migração');
   }else{
    const reopened=store.reopen(id)!;assert.equal(reopened.find(row=>row.id===id)?.done,false);assert.equal(reopened.some(row=>row.id===successor.id),false);
   }
  }
 }finally{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});}
});

test('v5 fingerprint migration preserves pre-existing successor edits for confirmation',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-v5-edited-successor-'));const path=join(directory,'test.sqlite');let store=freshStore(path);
 try{
  const area=store.createArea({name:'Área antiga'});const destination=store.createArea({name:'Área nova'});
  const task=store.create({title:'Fechamento mensal',when:'Planejada',plannedDate:'2026-01-31',recurrence:'monthly',areaId:area.id});
  const successor=store.complete(task.id)!.find(row=>row.seriesId===task.seriesId&&row.id!==task.id)!;const parent=store.get(task.id)!;
  const db=new DatabaseSync(path);
  const oldSnapshot={title:successor.title,project:successor.project,when:successor.when,plannedDate:successor.plannedDate??null,deadline:successor.deadline??null,notes:successor.notes,checklist:successor.checklist,recurrence:successor.recurrence??null,recurrenceAnchor:successor.recurrenceAnchor??null,areaId:successor.areaId??null,projectId:successor.projectId??null};
  db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify({...parent,successorSnapshot:JSON.stringify(oldSnapshot)}),task.id);
  store.update(successor.id,{areaId:destination.id});store.close();
  downgradeV7Database(db,5);db.close();
  store=openTaskStore(path,{now:fixedNow});
  assert.throws(()=>store.reopen(task.id),(error:unknown)=>error instanceof RecurrenceConflictError&&error.code==='edited-successor');
 }finally{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});}
});
