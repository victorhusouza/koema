import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openEventStore } from '../lib/event-store.ts';
import { EventInputError } from '../lib/events.ts';
import { openTaskStore } from '../lib/task-store.ts';
import { openBriefStore } from '../lib/brief-store.ts';

test('manual events create, edit, filter by date, order all-day first, delete, and persist after reopen', () => {
 const dir=mkdtempSync(join(tmpdir(),'painel-events-')); const path=join(dir,'test.sqlite');
 try {
  const tasks=openTaskStore(path); const task=tasks.create({title:'Tarefa preservada'}); tasks.close();
  const briefs=openBriefStore(path); const brief=briefs.save('2026-10-28',{Hoje:'Briefing preservado',Pendências:'',Semana:''}); briefs.close();
  const raw=new DatabaseSync(path); const versionBefore=(raw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version; raw.close();
  let store=openEventStore(path);
  const day='2026-10-28';
  const timedLate=store.create({title:'reunião tarde',date:day,time:'15:30'});
  const allDay=store.create({title:'compra',date:day,time:''});
  const timedEarly=store.create({title:'consulta',date:day,time:'09:00'});
  store.create({title:'futuro',date:'2026-10-29',time:null});
  assert.deepEqual(store.list(day).map(e=>e.id),[allDay.id,timedEarly.id,timedLate.id]);
  assert.equal(allDay.title,'Compra'); assert.equal(allDay.time,null);
  const updated=store.update(timedLate.id,{title:'reunião alterada',time:'08:15'}); assert.equal(updated?.title,'Reunião alterada');
  assert.deepEqual(store.list(day).map(e=>e.id),[allDay.id,timedLate.id,timedEarly.id]);
  store.close();
  store=openEventStore(path); assert.equal(store.list(day)[1].title,'Reunião alterada'); assert.equal(store.list('2026-10-29').length,1);
  assert.equal(store.remove(allDay.id),true); assert.equal(store.remove(allDay.id),false); assert.equal(store.list(day).length,2); store.close();
  const finalRaw=new DatabaseSync(path); assert.equal((finalRaw.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,versionBefore); finalRaw.close();
  const verifyTasks=openTaskStore(path); assert.ok(verifyTasks.get(task.id)); verifyTasks.close();
  const verifyBriefs=openBriefStore(path); assert.equal(verifyBriefs.get(day)?.Hoje,brief.Hoje); verifyBriefs.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('invalid event values are rejected without changing stored event', () => {
 const dir=mkdtempSync(join(tmpdir(),'painel-event-validation-')); const store=openEventStore(join(dir,'test.sqlite'));
 try {
  const saved=store.create({title:'compromisso válido',date:'2026-10-28',time:'11:00'});
  for(const input of [
   {title:'',date:'2026-10-28',time:null},
   {title:'Inválido',date:'2026-02-30',time:null},
   {title:'Inválido',date:'2026-10-28',time:'24:00'},
   {title:'Inválido',date:'2026-10-28',time:null,other:'unexpected'},
  ]) assert.throws(()=>store.update(saved.id,input),EventInputError);
  assert.deepEqual(store.list('2026-10-28'),[saved]);
  assert.throws(()=>store.list('2026-02-30'),EventInputError);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
