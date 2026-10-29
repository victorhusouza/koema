import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openTaskStore, RecurrenceConflictError, TaskInputError } from '../lib/task-store.ts';

function fixture(){const directory=mkdtempSync(join(tmpdir(),'koema-structure-'));const path=join(directory,'tasks.sqlite');return{directory,path};}

function makeVersionSixStore(path:string,editedSuccessor:boolean){
 const db=new DatabaseSync(path);db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
  CREATE TABLE areas(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL COLLATE NOCASE UNIQUE);
  CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT,area_id INTEGER NOT NULL REFERENCES areas(id),name TEXT NOT NULL COLLATE NOCASE,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),completed_at TEXT,UNIQUE(area_id,name));
  PRAGMA user_version=6;`);
 const successor={id:2,title:editedSuccessor?'Edited next':'Next',project:'',when:'Planejada',plannedDate:'2026-10-30',deadline:null,notes:'',checklist:[],recurrence:'daily',recurrenceAnchor:null,areaId:null,projectId:null,done:false,seriesId:1,occurrence:2,previousId:1};
 const oldSnapshot={title:'Next',when:'Planejada',plannedDate:'2026-10-30',deadline:null,notes:'',checklist:[],recurrence:'daily',recurrenceAnchor:null,areaId:null,projectId:null};
 const previous={id:1,title:'First',project:'',when:'Planejada',plannedDate:'2026-10-29',deadline:null,notes:'',checklist:[],recurrence:'daily',areaId:null,projectId:null,done:true,completed:'2026-10-29T12:00:00.000Z',seriesId:1,occurrence:1,successorId:2,successorSnapshot:JSON.stringify(oldSnapshot)};
 db.prepare('INSERT INTO tasks(id,body) VALUES (?,?)').run(1,JSON.stringify(previous));db.prepare('INSERT INTO tasks(id,body) VALUES (?,?)').run(2,JSON.stringify(successor));db.close();
}

test('tag hierarchy, project and area assignments, and heading links stay stable',()=>{
 const f=fixture();const store=openTaskStore(f.path);
 try{
  const root=store.createTag({name:'Trabalho',shortcut:'T'});const child=store.createTag({name:'Escrita',parentId:root.id});
  assert.throws(()=>store.updateTag(root.id,{parentId:child.id}),TaskInputError);
  const area=store.createArea({name:'Projetos',tagIds:[child.id]});const project=store.createProject({name:'Plano',areaId:area.id,notes:'notas',plannedDate:'2026-11-01'});
  const heading=store.createHeading({projectId:project.id,title:''});
  const task=store.create({title:'Rascunhar',projectId:project.id,areaId:area.id,headingId:heading.id,tagIds:[]});
  const template=store.createSchedule({title:'Tag test',notes:'',checklist:[],areaId:area.id,projectId:project.id,headingId:heading.id,tagIds:[child.id],deadlineOffset:null,reminderTime:null,rule:{mode:'calendar',unit:'week',interval:1,anchorDate:'2026-11-02'}});
  assert.deepEqual(task.effectiveTagIds,[root.id,child.id]);assert.equal(task.headingId,heading.id);
  const ownChild=store.create({title:'Etiqueta própria',tagIds:[child.id]});assert.deepEqual(ownChild.effectiveTagIds,[root.id,child.id]);
  assert.throws(()=>store.create({title:'Incompatível',areaId:area.id,headingId:heading.id}),TaskInputError);
  const other=store.createProject({name:'Sem área'});assert.equal(other.areaId,null);assert.equal(other.notes,'');
  store.updateProject(project.id,{areaId:null,deadline:'2026-11-08'});assert.equal(store.projects().find(item=>item.id===project.id)?.areaName,null);assert.equal(store.get(task.id)?.areaId,null);
  store.removeHeading(heading.id);assert.equal(store.get(task.id)?.headingId,null);assert.equal(store.schedules().find(item=>item.id===template.id)?.headingId,null);
  store.removeTag(child.id);assert.deepEqual(store.get(task.id)?.tagIds,[]);assert.deepEqual(store.areas().find(item=>item.id===area.id)?.tagIds,[]);assert.deepEqual(store.schedules().find(item=>item.id===template.id)?.tagIds,[]);
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('v6 successor fingerprints migrate in canonical order without hiding old edits',()=>{
 const clean=fixture();
 try{makeVersionSixStore(clean.path,false);const store=openTaskStore(clean.path,{now:()=>new Date('2026-10-29T12:00:00Z')});try{const rows=store.reopen(1);assert.ok(rows);assert.equal(store.get(1)?.done,false);assert.equal(store.get(2),undefined);}finally{store.close();}}finally{rmSync(clean.directory,{recursive:true,force:true});}
 const edited=fixture();
 try{makeVersionSixStore(edited.path,true);const store=openTaskStore(edited.path,{now:()=>new Date('2026-10-29T12:00:00Z')});try{assert.throws(()=>store.reopen(1),(error:unknown)=>error instanceof RecurrenceConflictError&&error.code==='edited-successor');}finally{store.close();}}finally{rmSync(edited.directory,{recursive:true,force:true});}
});

test('calendar schedules materialize idempotently with due instances and a future preview',()=>{
 const f=fixture();const store=openTaskStore(f.path,{now:()=>new Date('2026-10-29T12:00:00Z')});
 try{
  const schedule=store.createSchedule({title:'Revisar diário',notes:'',checklist:[],areaId:null,projectId:null,headingId:null,tagIds:[],deadlineOffset:null,reminderTime:null,rule:{mode:'calendar',unit:'day',interval:1,anchorDate:'2026-10-28'}});
  assert.deepEqual(store.materializeSchedules('2026-10-29'),{created:3,truncated:false});
  const second=openTaskStore(f.path,{now:()=>new Date('2026-10-29T12:00:00Z')});
  try{assert.deepEqual(second.materializeSchedules('2026-10-29'),{created:0,truncated:false});}finally{second.close();}
  const occurrences=store.list().filter(task=>task.scheduleId===schedule.id).sort((a,b)=>a.scheduledFor!.localeCompare(b.scheduledFor!));
  assert.deepEqual(occurrences.map(task=>task.scheduledFor),['2026-10-28','2026-10-29','2026-10-30']);
  store.removeSchedule(schedule.id);assert.ok(store.list().filter(task=>task.title==='Revisar diário').every(task=>task.scheduleId==null));
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('materialization limits each batch to 100 and rotates fairly across templates',()=>{
 const f=fixture();const store=openTaskStore(f.path,{now:()=>new Date('2026-10-29T12:00:00Z')});
 try{
  const ids:number[]=[];
  for(let index=0;index<101;index++){const item=store.createSchedule({title:`Template ${index}`,notes:'',checklist:[],areaId:null,projectId:null,headingId:null,tagIds:[],deadlineOffset:null,reminderTime:null,rule:{mode:'calendar',unit:'day',interval:1,anchorDate:'2026-10-30'}});ids.push(item.id);}
  const first=store.materializeSchedules('2026-10-29');assert.equal(first.created,100);assert.equal(first.truncated,true);assert.equal(store.list().filter(task=>task.scheduleId!==null).length,100);
  const second=store.materializeSchedules('2026-10-29');assert.equal(second.created,1);assert.equal(store.list().filter(task=>task.scheduleId!==null).length,101);
  assert.ok(ids.every(id=>store.list().some(task=>task.scheduleId===id)));
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('after-completion schedules wait for completion, use actual completion date, and respect pause',()=>{
 const f=fixture();const store=openTaskStore(f.path,{now:()=>new Date('2026-10-29T12:00:00Z')});
 try{
  const schedule=store.createSchedule({title:'Revisão quinzenal',notes:'',checklist:[],areaId:null,projectId:null,headingId:null,tagIds:[],deadlineOffset:null,reminderTime:'09:30',rule:{mode:'after-completion',unit:'week',interval:2,anchorDate:'2026-10-20'}});
  store.materializeSchedules('2026-10-29');const first=store.list().find(task=>task.scheduleId===schedule.id)!;assert.equal(first.scheduledFor,'2026-10-20');
  store.update(first.id,{done:true});const next=store.list().find(task=>task.scheduleId===schedule.id&&!task.done)!;assert.equal(next.scheduledFor,'2026-11-12');
  const paused=store.updateSchedule(schedule.id,{rule:{paused:true}})!;assert.equal(paused.rule.paused,true);
  assert.equal(store.updateTag(99,{name:'Missing'}),undefined);
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('after-completion successors reopen safely and reject older history',()=>{
 const f=fixture();let clock=new Date('2026-10-29T12:00:00Z');const store=openTaskStore(f.path,{now:()=>clock});
 try{
  const schedule=store.createSchedule({title:'Reopen flow',notes:'',checklist:[],areaId:null,projectId:null,headingId:null,tagIds:[],deadlineOffset:null,reminderTime:null,rule:{mode:'after-completion',unit:'week',interval:1,anchorDate:'2026-10-29'}});
  store.materializeSchedules('2026-10-29');const first=store.list().find(task=>task.scheduleId===schedule.id)!;store.update(first.id,{done:true});
  const second=store.list().find(task=>task.scheduleId===schedule.id&&!task.done)!;assert.equal(second.previousId,first.id);
  store.update(second.id,{notes:'Edited successor'});
  let fingerprint='';assert.throws(()=>store.update(first.id,{done:false}),(error:unknown)=>{if(error instanceof RecurrenceConflictError){fingerprint=error.successorFingerprint??'';return error.code==='edited-successor';}return false;});
  assert.ok(fingerprint);store.reopen(first.id,{successorId:second.id,successorFingerprint:fingerprint});assert.equal(store.get(second.id),undefined);assert.equal(store.get(first.id)?.done,false);
  store.update(first.id,{done:true});const next=store.list().find(task=>task.scheduleId===schedule.id&&!task.done)!;clock=new Date('2026-11-05T12:00:00Z');store.update(next.id,{done:true});
  assert.throws(()=>store.reopen(first.id),(error:unknown)=>error instanceof RecurrenceConflictError&&error.code==='completed-successor');
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('unpausing resumes after a completion that happened while paused',()=>{
 const f=fixture();const store=openTaskStore(f.path,{now:()=>new Date('2026-10-29T12:00:00Z')});
 try{
  const schedule=store.createSchedule({title:'Pause flow',notes:'',checklist:[],areaId:null,projectId:null,headingId:null,tagIds:[],deadlineOffset:null,reminderTime:null,rule:{mode:'after-completion',unit:'week',interval:2,anchorDate:'2026-10-20'}});
  store.materializeSchedules('2026-10-29');const first=store.list().find(task=>task.scheduleId===schedule.id)!;
  store.updateSchedule(schedule.id,{rule:{paused:true}});store.update(first.id,{done:true});assert.equal(store.list().filter(task=>task.scheduleId===schedule.id&&!task.done).length,0);
  store.updateSchedule(schedule.id,{rule:{paused:false}});const next=store.list().find(task=>task.scheduleId===schedule.id&&!task.done)!;
  assert.equal(next.scheduledFor,'2026-11-12');assert.equal(next.previousId,first.id);
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('future source IDs stay immutable across API edits and deduplicate within each entity type',()=>{
 const f=fixture();const store=openTaskStore(f.path);
 try{
  const first=store.create({title:'Imported task',sourceId:'task:things:1'});const second=store.create({title:'Other task'});
  assert.equal(first.sourceId,undefined);
  const db=new DatabaseSync(f.path);
  const taskBody=JSON.parse((db.prepare('SELECT body FROM tasks WHERE id=?').get(first.id) as {body:string}).body);taskBody.sourceId='things:task:1';db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(taskBody),first.id);
  const duplicateBody=JSON.parse((db.prepare('SELECT body FROM tasks WHERE id=?').get(second.id) as {body:string}).body);duplicateBody.sourceId='things:task:1';assert.throws(()=>db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(duplicateBody),second.id));
  db.close();
  const schedule=store.createSchedule({title:'Imported schedule',notes:'',checklist:[],areaId:null,projectId:null,headingId:null,tagIds:[],deadlineOffset:null,reminderTime:null,rule:{mode:'after-completion',unit:'day',interval:1,anchorDate:'2026-10-29'}});
  const raw=new DatabaseSync(f.path);const scheduleBody=JSON.parse((raw.prepare('SELECT body FROM recurring_schedules WHERE id=?').get(schedule.id) as {body:string}).body);scheduleBody.sourceId='things:repeat:1';raw.prepare('UPDATE recurring_schedules SET body=? WHERE id=?').run(JSON.stringify(scheduleBody),schedule.id);raw.close();
  const updated=store.updateSchedule(schedule.id,{rule:{paused:true}})!;assert.equal(updated.sourceId,'things:repeat:1');
  const other=store.createSchedule({title:'Another schedule',notes:'',checklist:[],areaId:null,projectId:null,headingId:null,tagIds:[],deadlineOffset:null,reminderTime:null,rule:{mode:'after-completion',unit:'day',interval:1,anchorDate:'2026-10-29'}});
  const duplicate=new DatabaseSync(f.path);const otherBody=JSON.parse((duplicate.prepare('SELECT body FROM recurring_schedules WHERE id=?').get(other.id) as {body:string}).body);otherBody.sourceId='things:repeat:1';assert.throws(()=>duplicate.prepare('UPDATE recurring_schedules SET body=? WHERE id=?').run(JSON.stringify(otherBody),other.id));duplicate.close();
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('legacy recurring successors shift reminders by the new planned day in Belém time',()=>{
 const f=fixture();const store=openTaskStore(f.path,{now:()=>new Date('2026-10-29T12:00:00Z')});
 try{
  const task=store.create({title:'Reminder series',when:'Planejada',plannedDate:'2026-10-29',reminderAt:'2026-10-29T11:00:00.000Z',recurrence:'daily'});
  store.update(task.id,{done:true});const next=store.list().find(item=>item.previousId===task.id)!;
  assert.equal(next.plannedDate,'2026-10-30');assert.equal(next.reminderAt,'2026-10-30T11:00:00.000Z');
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});
