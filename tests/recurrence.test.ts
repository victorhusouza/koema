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

test('migration refreshes daily successor fingerprints without changing existing series behavior',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-recurrence-v5-migration-'));const path=join(directory,'test.sqlite');let store=freshStore(path);
 try{
  const first=makeDaily(store,'2026-10-30');const successor=store.complete(first.id)!.find(task=>task.id!==first.id)!;const completed=store.list().find(task=>task.id===first.id)!;store.close();
  const db=new DatabaseSync(path);const oldSnapshot={title:successor.title,project:successor.project,when:successor.when,plannedDate:successor.plannedDate??null,deadline:successor.deadline??null,notes:successor.notes,checklist:successor.checklist,recurrence:successor.recurrence??null};
  db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify({...completed,successorSnapshot:JSON.stringify(oldSnapshot)}),first.id);db.exec('PRAGMA user_version=4');db.close();
  store=openTaskStore(path,{now:fixedNow});const reopened=store.reopen(first.id)!;assert.equal(reopened.find(task=>task.id===first.id)?.done,false);assert.equal(reopened.some(task=>task.id===successor.id),false);store.close();
 }finally{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});}
});
