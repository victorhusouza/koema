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
import { POST } from '../app/api/events/route.ts';
import { PATCH, DELETE } from '../app/api/events/[id]/route.ts';
import { testSession } from './auth-fixture.ts';

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

test('event mutation routes enforce same-origin JSON and preserve local host aliases', async () => {
 const dir=mkdtempSync(join(tmpdir(),'painel-event-routes-')); const previous=process.env.PAINEL_DB_PATH; process.env.PAINEL_DB_PATH=join(dir,'test.sqlite');
 const session=testSession(process.env.PAINEL_DB_PATH);const sameOrigin={Host:'127.0.0.1:3000',Origin:'http://127.0.0.1:3000',Cookie:`koema_session=${session.token}`};
 const json={...sameOrigin,'Content-Type':'application/json; charset=utf-8'};
 const body=JSON.stringify({title:'Consulta',date:'2026-10-28',time:'11:30'});
 try {
  for (const request of [
   new Request('http://localhost:3000/api/events',{method:'POST',headers:{...json,Origin:'null'},body}),
   new Request('http://localhost:3000/api/events',{method:'POST',headers:{...sameOrigin,'Content-Type':'text/plain'},body}),
   new Request('http://localhost:3000/api/events',{method:'POST',headers:json,body:'{' }),
  ]) assert.ok([400,403,415].includes((await POST(request)).status));
  assert.equal((await POST(new Request('http://localhost:3000/api/events',{method:'POST',headers:{Cookie:`koema_session=${session.token}`,'Content-Type':'application/json'},body}))).status,403);
  const created=await POST(new Request('http://localhost:3000/api/events',{method:'POST',headers:json,body}));
  assert.equal(created.status,201);
  const event=await created.json();
  for (const origin of ['https://evil.example','not-an-origin','null']) {
   const denied=await PATCH(new Request(`http://localhost:3000/api/events/${event.id}`,{method:'PATCH',headers:{...json,Origin:origin},body}),{params:Promise.resolve({id:String(event.id)})});
   assert.equal(denied.status,403);
   const deleteDenied=await DELETE(new Request(`http://localhost:3000/api/events/${event.id}`,{method:'DELETE',headers:{...sameOrigin,Origin:origin}}),{params:Promise.resolve({id:String(event.id)})});
   assert.equal(deleteDenied.status,403);
  }
  const patchNoJson=await PATCH(new Request(`http://localhost:3000/api/events/${event.id}`,{method:'PATCH',headers:sameOrigin,body}),{params:Promise.resolve({id:String(event.id)})});
  assert.equal(patchNoJson.status,415);
  assert.equal((await DELETE(new Request(`http://localhost:3000/api/events/${event.id}`,{method:'DELETE',headers:{Cookie:`koema_session=${session.token}`}}),{params:Promise.resolve({id:String(event.id)})})).status,403);
  const changed=await PATCH(new Request(`http://localhost:3000/api/events/${event.id}`,{method:'PATCH',headers:json,body:JSON.stringify({title:'Consulta alterada',date:'2026-10-28',time:'11:30'})}),{params:Promise.resolve({id:String(event.id)})});
  assert.equal(changed.status,200);
  const deleted=await DELETE(new Request(`http://localhost:3000/api/events/${event.id}`,{method:'DELETE',headers:sameOrigin}),{params:Promise.resolve({id:String(event.id)})});
  assert.equal(deleted.status,200);
 } finally { if(previous===undefined) delete process.env.PAINEL_DB_PATH; else process.env.PAINEL_DB_PATH=previous; rmSync(dir,{recursive:true,force:true}); }
});
