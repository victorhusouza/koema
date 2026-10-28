import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localDay, addDays, todayTasks, upcoming, validDate } from '../lib/task-dates.ts';
import { openTaskStore, TaskInputError } from '../lib/task-store.ts';

test('day boundary uses Belem and calendar validates leap days',()=>{
 assert.equal(localDay(new Date('2026-10-29T02:59:59Z')),'2026-10-28');
 assert.equal(localDay(new Date('2026-10-29T03:00:00Z')),'2026-10-29');
 assert.equal(addDays('2026-12-31',1),'2027-01-01');
 assert.equal(validDate('2026-02-29'),false);assert.equal(validDate('2028-02-29'),true);
});

test('independent dates, carryover, upcoming, durable order and rejected stale reorder',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-planning-'));const path=join(directory,'test.sqlite');
 let store=openTaskStore(path);
 try{
  for(const t of store.list())store.remove(t.id);
  const day=localDay();
  const overdue=store.create({title:'Ontem',plannedDate:addDays(day,-1),deadline:addDays(day,5)});
  const now=store.create({title:'Hoje',plannedDate:day});
  const later=store.create({title:'Depois',plannedDate:addDays(day,3)});
  const tomorrow=store.create({title:'Amanhã',plannedDate:addDays(day,1)});
  const deadlineOnly=store.create({title:'Só prazo',deadline:day});
  assert.deepEqual(todayTasks(store.list(),day).map(t=>t.id),[overdue.id,now.id]);
  assert.deepEqual(upcoming(store.list(),day).map(t=>t.id),[tomorrow.id,later.id]);
  assert.equal(deadlineOnly.plannedDate,null);
  store.update(overdue.id,{plannedDate:day});
  assert.equal(store.list().find(t=>t.id===overdue.id)!.deadline,addDays(day,5));
  store.reorder([now.id,overdue.id]);store.close();store=openTaskStore(path);
  assert.deepEqual(todayTasks(store.list(),day).map(t=>t.id),[now.id,overdue.id]);
  assert.throws(()=>store.reorder([now.id,now.id]),TaskInputError);
  assert.throws(()=>store.reorder([now.id]),TaskInputError);
  assert.throws(()=>store.update(now.id,{deadline:'2026-02-30'}),TaskInputError);
  assert.deepEqual(todayTasks(store.list(),addDays(day,1)).map(t=>t.id).sort(),[now.id,overdue.id,tomorrow.id].sort());
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('version 1 migrates once preserving task content and historical dates',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-migration-'));const path=join(directory,'test.sqlite');
 try {
  const db=new DatabaseSync(path);db.exec('CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL); PRAGMA user_version=1');
  db.prepare('INSERT INTO tasks(id,body) VALUES(1,?)').run(JSON.stringify({title:'Minha tarefa',when:'Hoje',notes:'Anotação original',done:false,checklist:[],project:''}));db.close();
  let store=openTaskStore(path);assert.equal(store.list().length,1);assert.equal(store.list()[0].plannedDate,'2026-10-28');
  store.update(1,{plannedDate:'2026-11-15'});store.close();store=openTaskStore(path);
  assert.equal(store.list()[0].plannedDate,'2026-11-15');assert.equal(store.list()[0].notes,'Anotação original');store.close();
 }finally{rmSync(directory,{recursive:true,force:true});}
});
