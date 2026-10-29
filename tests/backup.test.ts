import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPortableBackup, MAX_BACKUP_BYTES, restoreToSeparateDatabase } from '../lib/backup.ts';
import { openTaskStore } from '../lib/task-store.ts';
import { openBriefStore } from '../lib/brief-store.ts';
import { openEventStore } from '../lib/event-store.ts';
import { POST as backupPost } from '../app/api/backup/route.ts';
import { testSession } from './auth-fixture.ts';

function fixture() {
 const directory = mkdtempSync(join(tmpdir(), 'koema-backup-test-'));
 const path = join(directory, 'active.sqlite');
 const tasks = openTaskStore(path, { now: () => new Date('2026-10-28T12:00:00Z') });
 const area = tasks.createArea({ name: 'Teste' });
 const project = tasks.createProject({ areaId: area.id, name: 'Projeto fictício' });
 tasks.create({ title: 'Tarefa fictícia', when: 'Hoje', plannedDate: '2026-10-28', areaId: area.id, projectId: project.id, recurrence: 'weekly' });
 tasks.create({ title: 'Tarefa de semana', when: 'Planejada', plannedDate: '2026-10-28', recurrence: 'weekdays' });
 tasks.create({ title: 'Tarefa de fim de semana', when: 'Planejada', plannedDate: '2026-10-31', recurrence: 'weekends' });
 tasks.close();
 const brief = openBriefStore(path); brief.save('2026-10-28', { Hoje: 'Revisar', Pendências: 'Nenhuma', Semana: 'Planejar' }); brief.close();
 const events = openEventStore(path); events.create({ title: 'Compromisso fictício', date: '2026-10-28', time: '10:30' }); events.close();
 return { directory, path };
}

test('portable snapshot preserves WAL-backed domains and excludes calendar secrets', async () => {
 const f = fixture();
 try {
  const source = new DatabaseSync(f.path);
  source.exec("CREATE TABLE google_calendar_metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO google_calendar_metadata VALUES ('ical_url','SECRET_URL_FIXTURE'); INSERT INTO google_calendar_metadata VALUES ('tokens','SECRET_TOKEN_FIXTURE'); INSERT INTO google_calendar_metadata VALUES ('encrypted_tokens','CIPHERTEXT_SECRET_FIXTURE');");
  source.close();
  const result = await createPortableBackup(f.path, f.directory);
  for (const marker of ['SECRET_URL_FIXTURE', 'SECRET_TOKEN_FIXTURE', 'CIPHERTEXT_SECRET_FIXTURE']) assert.ok(!result.bytes.includes(Buffer.from(marker)));
  assert.deepEqual(result.info.counts, { tasks: 14, areas: 3, projects: 2, briefings: 2, manualEvents: 1, headings:0, tags:0, schedules:0 });
  // Read the returned portable image through a private temporary file.
  const snapshotPath = join(f.directory, 'export.sqlite'); writeFileSync(snapshotPath, result.bytes);
  const copy = new DatabaseSync(snapshotPath);
  const names = (copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row => row.name);
  assert.ok(!names.includes('google_calendar_metadata'));
  assert.ok(names.includes('briefing_metadata'));
  assert.ok(names.includes('manual_event_metadata'));
  assert.ok(names.includes('headings'));assert.ok(names.includes('tags'));assert.ok(names.includes('recurring_schedules'));assert.ok(names.includes('schedule_materializer_state'));
  assert.equal((copy.prepare("SELECT value FROM koema_backup_metadata WHERE key='format_version'").get() as {value:string}).value, '1');
  copy.close();
 } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('portable exports strip owner credentials and sessions; restore keeps identity out', async () => {
 const f = fixture();
 try {
  const session = testSession(f.path);
  const source = new DatabaseSync(f.path);
  source.prepare('UPDATE koema_owner SET password_hash=?,password_salt=? WHERE id=1').run('OWNER_HASH_MARKER', 'OWNER_SALT_MARKER');
  source.prepare('INSERT INTO koema_sessions(token_hash,owner_id,created_at,expires_at,absolute_expires_at,last_seen_at) VALUES (\'SESSION_HASH_MARKER\',1,1,2,3,1)').run();
  source.close();
  const exported = await createPortableBackup(f.path, f.directory);
  for (const marker of ['OWNER_HASH_MARKER', 'OWNER_SALT_MARKER', 'SESSION_HASH_MARKER', session.token]) {
   assert.ok(!exported.bytes.includes(Buffer.from(marker)), `backup contained ${marker}`);
  }
  const restored = await restoreToSeparateDatabase(exported.bytes, f.path);
  const restoredDirectory = join(f.directory, 'restored-backups');
  const restoredName = (await import('node:fs')).readdirSync(restoredDirectory).find(name => name.endsWith('.sqlite'))!;
  const copy = new DatabaseSync(join(restoredDirectory, restoredName));
  try {
   const names = (copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row => row.name);
   assert.ok(!names.some(name => ['koema_owner', 'koema_sessions', 'koema_login_attempts'].includes(name)));
   assert.equal(restored.info.counts.tasks, exported.info.counts.tasks);
   const recurrences=(copy.prepare("SELECT json_extract(body,'$.recurrence') AS recurrence FROM tasks WHERE json_extract(body,'$.recurrence') IN ('weekdays','weekends') ORDER BY recurrence").all() as {recurrence:string}[]).map(row=>row.recurrence);
   assert.deepEqual(recurrences,['weekdays','weekends']);
  } finally { copy.close(); }
 } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('restore verifies a separate staged copy and leaves the active database unchanged', async () => {
 const f = fixture();
 try {
  const original = await createPortableBackup(f.path, f.directory);
  const before = new DatabaseSync(f.path); const beforeCount = Number((before.prepare('SELECT COUNT(*) AS n FROM tasks').get() as {n:number}).n); before.close();
  const restored = await restoreToSeparateDatabase(original.bytes, f.path);
  assert.deepEqual(restored.info.counts, original.info.counts);
  assert.ok(!restored.storageLabel.includes(f.path));
  const after = new DatabaseSync(f.path); assert.equal(Number((after.prepare('SELECT COUNT(*) AS n FROM tasks').get() as {n:number}).n), beforeCount); after.close();
  const { readdirSync } = await import('node:fs'); const stage = join(f.directory, 'restored-backups');
  assert.equal(readdirSync(stage).filter(name => name.endsWith('.sqlite')).length, 1);
 } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('restore accepts a compatible v6 backup with its original schema and metadata',async()=>{
 const f=fixture();const legacyPath=join(f.directory,'legacy-v6.sqlite');
 try{
  const db=new DatabaseSync(legacyPath);db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
   CREATE TABLE areas(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL COLLATE NOCASE UNIQUE);
   CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT,area_id INTEGER NOT NULL REFERENCES areas(id),name TEXT NOT NULL COLLATE NOCASE,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),completed_at TEXT,UNIQUE(area_id,name));
   CREATE TABLE koema_backup_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);PRAGMA user_version=6;`);
  db.prepare('INSERT INTO areas(name) VALUES (?)').run('Legacy');db.prepare('INSERT INTO projects(area_id,name) VALUES (1,?)').run('Project');
  db.prepare('INSERT INTO tasks(body) VALUES (?)').run(JSON.stringify({title:'Legacy task',done:false,when:'Caixa de entrada',checklist:[]}));
  const info={createdAt:'2026-10-01T00:00:00.000Z',appVersion:'0.1.0',schemaVersion:6,counts:{tasks:1,areas:1,projects:1,briefings:0,manualEvents:0}};
  db.prepare('INSERT INTO koema_backup_metadata(key,value) VALUES (?,?)').run('format_version','1');db.prepare('INSERT INTO koema_backup_metadata(key,value) VALUES (?,?)').run('backup_info',JSON.stringify(info));db.close();
  const restored=await restoreToSeparateDatabase(readFileSync(legacyPath),f.path);assert.equal(restored.info.schemaVersion,6);assert.deepEqual(restored.info.counts,info.counts);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('v7 backup preserves tags, headings, and recurrence templates while removing notification secrets',async()=>{
 const f=fixture();
 try{
  const store=openTaskStore(f.path);const tag=store.createTag({name:'Imported',shortcut:'I'});const project=store.projects()[0];const heading=store.createHeading({projectId:project.id,title:''});
  const schedule=store.createSchedule({title:'Template',notes:'Notes',checklist:[],areaId:project.areaId,projectId:project.id,headingId:heading.id,tagIds:[tag.id],deadlineOffset:2,reminderTime:'08:15',rule:{mode:'calendar',unit:'week',interval:1,anchorDate:'2026-10-28'}});store.close();
  const raw=new DatabaseSync(f.path);raw.exec("CREATE TABLE push_subscriptions(id TEXT PRIMARY KEY,secret TEXT);INSERT INTO push_subscriptions VALUES ('test','PUSH_DELIVERY_SECRET');");
  raw.prepare('UPDATE areas SET source_id=? WHERE id=?').run('things:area:1',project.areaId);
  raw.prepare('UPDATE projects SET source_id=? WHERE id=?').run('things:project:1',project.id);
  raw.prepare('UPDATE tags SET source_id=? WHERE id=?').run('things:tag:1',tag.id);
  raw.prepare('UPDATE headings SET source_id=? WHERE id=?').run('things:heading:1',heading.id);
  const taskRow=raw.prepare('SELECT id,body FROM tasks ORDER BY id LIMIT 1').get() as {id:number;body:string};const taskBody=JSON.parse(taskRow.body);taskBody.sourceId='things:task:1';raw.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(taskBody),taskRow.id);
  const scheduleRow=raw.prepare('SELECT body FROM recurring_schedules WHERE id=?').get(schedule.id) as {body:string};const scheduleBody=JSON.parse(scheduleRow.body);scheduleBody.sourceId='things:repeat:1';raw.prepare('UPDATE recurring_schedules SET body=? WHERE id=?').run(JSON.stringify(scheduleBody),schedule.id);raw.close();
  const exported=await createPortableBackup(f.path,f.directory);assert.equal(exported.info.counts.tags,1);assert.equal(exported.info.counts.headings,1);assert.equal(exported.info.counts.schedules,1);assert.ok(!exported.bytes.includes(Buffer.from('PUSH_DELIVERY_SECRET')));
  const restored=await restoreToSeparateDatabase(exported.bytes,f.path);assert.equal(restored.info.counts.tags,1);
  const stage=join(f.directory,'restored-backups');const path=join(stage,(await import('node:fs')).readdirSync(stage).find(name=>name.endsWith('.sqlite'))!);const copy=new DatabaseSync(path);
  try{assert.equal((copy.prepare('SELECT title,source_id AS sourceId FROM headings WHERE id=?').get(heading.id) as {title:string;sourceId:string}).sourceId,'things:heading:1');assert.equal((copy.prepare('SELECT source_id FROM areas WHERE id=?').get(project.areaId) as {source_id:string}).source_id,'things:area:1');assert.equal((copy.prepare('SELECT source_id FROM projects WHERE id=?').get(project.id) as {source_id:string}).source_id,'things:project:1');assert.equal((copy.prepare('SELECT source_id FROM tags WHERE id=?').get(tag.id) as {source_id:string}).source_id,'things:tag:1');const task=JSON.parse((copy.prepare('SELECT body FROM tasks WHERE id=?').get(taskRow.id) as {body:string}).body);assert.equal(task.sourceId,'things:task:1');const saved=JSON.parse((copy.prepare('SELECT body FROM recurring_schedules WHERE id=?').get(schedule.id) as {body:string}).body);assert.deepEqual(saved.tagIds,[tag.id]);assert.equal(saved.headingId,heading.id);assert.equal(saved.sourceId,'things:repeat:1');assert.equal((copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_subscriptions'").get()),undefined);}finally{copy.close();}
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('restore detects duplicated imported IDs even if an uploaded copy removed its indexes',async()=>{
 const f=fixture();
 try{
  const store=openTaskStore(f.path);
  const scheduleInput={title:'Imported schedule',notes:'',checklist:[],areaId:null,projectId:null,headingId:null,tagIds:[],deadlineOffset:null,reminderTime:null,rule:{mode:'after-completion',unit:'day',interval:1,anchorDate:'2026-10-28'}};
  const firstSchedule=store.createSchedule(scheduleInput);const secondSchedule=store.createSchedule({...scheduleInput,title:'Other imported schedule'});store.close();
  const exported=await createPortableBackup(f.path,f.directory);
  for(const entity of ['task','schedule'] as const){
   const corruptedPath=join(f.directory,`duplicate-${entity}-source.sqlite`);writeFileSync(corruptedPath,exported.bytes);const db=new DatabaseSync(corruptedPath);
   db.exec('DROP INDEX tasks_source_id;DROP INDEX recurring_schedules_source_id;');
   if(entity==='task'){
    const rows=db.prepare('SELECT id,body FROM tasks ORDER BY id LIMIT 2').all() as {id:number;body:string}[];
    for(const row of rows){const body=JSON.parse(row.body);body.sourceId='things:duplicate-task';db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(body),row.id);}
   }else{
    const rows=db.prepare('SELECT id,body FROM recurring_schedules WHERE id IN (?,?)').all(firstSchedule.id,secondSchedule.id) as {id:number;body:string}[];
    for(const row of rows){const body=JSON.parse(row.body);body.sourceId='things:duplicate-repeat';db.prepare('UPDATE recurring_schedules SET body=? WHERE id=?').run(JSON.stringify(body),row.id);}
   }
   db.close();await assert.rejects(()=>restoreToSeparateDatabase(readFileSync(corruptedPath),f.path),/identificador de origem inválido ou duplicado/);
  }
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('restore rejects damaged, oversized, unknown-schema and secret-bearing files', async () => {
 const f = fixture();
 try {
  const good = (await createPortableBackup(f.path, f.directory)).bytes;
  await assert.rejects(() => restoreToSeparateDatabase(good.subarray(0, 50), f.path), /SQLite/);
  const corrupt = Buffer.from(good); corrupt[16] = 0;
  await assert.rejects(() => restoreToSeparateDatabase(corrupt, f.path));
  await assert.rejects(() => restoreToSeparateDatabase(Buffer.alloc(MAX_BACKUP_BYTES + 1), f.path), /64 MB/);
  const unknown = join(f.directory, 'unknown.sqlite'); writeFileSync(unknown, good);
  const changed = new DatabaseSync(unknown); changed.exec('PRAGMA user_version=999'); changed.close();
  await assert.rejects(() => restoreToSeparateDatabase(readFileSync(unknown), f.path), /versão/);
  const secret = join(f.directory, 'secret.sqlite'); writeFileSync(secret, good);
  const secretDb = new DatabaseSync(secret); secretDb.exec("CREATE TABLE google_calendar_metadata(key TEXT PRIMARY KEY,value TEXT)"); secretDb.close();
  await assert.rejects(() => restoreToSeparateDatabase(readFileSync(secret), f.path), /não reconhece/);
  const invalidRecurrence = join(f.directory, 'invalid-recurrence.sqlite'); writeFileSync(invalidRecurrence, good);
  const invalidDb = new DatabaseSync(invalidRecurrence); invalidDb.prepare("UPDATE tasks SET body=json_set(body,'$.recurrence','holidays') WHERE id=(SELECT MIN(id) FROM tasks)").run(); invalidDb.close();
  await assert.rejects(() => restoreToSeparateDatabase(readFileSync(invalidRecurrence), f.path), /repetição inválida/);
 } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('upload ignores client filenames and enforces origin and multipart content type', async () => {
 const f = fixture();
 const previous = process.env.PAINEL_DB_PATH;
 process.env.PAINEL_DB_PATH = f.path;
 try {
  const session=testSession(f.path);const auth={cookie:`koema_session=${session.token}`};
  const portable = (await createPortableBackup(f.path, f.directory)).bytes;
  const denied = await backupPost(new Request('http://127.0.0.1:3000/api/backup', { method: 'POST', headers: { ...auth,host: '127.0.0.1:3000', 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(denied.status, 403);
  const exported = await backupPost(new Request('http://127.0.0.1:3000/api/backup', { method: 'POST', headers: { ...auth,host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(exported.status, 200);
  assert.ok(Buffer.from(await exported.arrayBuffer()).subarray(0, 16).equals(Buffer.from('SQLite format 3\0')));
  const wrongType = await backupPost(new Request('http://127.0.0.1:3000/api/backup', { method: 'POST', headers: { ...auth,host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'text/plain' }, body: '{}' }));
  assert.equal(wrongType.status, 415);
  let generated = 0;
  const oversizedBody = new ReadableStream<Uint8Array>({ pull(controller) { if (generated++ >= 65) controller.close(); else controller.enqueue(new Uint8Array(1024 * 1024)); } });
  const oversized = await backupPost(new Request('http://127.0.0.1:3000/api/backup', { method: 'POST', headers: { ...auth,host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'multipart/form-data; boundary=unused', 'content-length': '1' }, body: oversizedBody, duplex: 'half' } as RequestInit & { duplex: 'half' }));
  assert.equal(oversized.status, 413);
  const form = new FormData(); form.set('backup', new File([new Uint8Array(portable)], '../../active.sqlite'));
  const restored = await backupPost(new Request('http://127.0.0.1:3000/api/backup', { method: 'POST', headers: { ...auth,host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-length': String(portable.length + 1024) }, body: form }));
  assert.equal(restored.status, 200);
  const stageNames = (await import('node:fs')).readdirSync(join(f.directory, 'restored-backups'));
  assert.equal(stageNames.length, 1);
  assert.ok(stageNames[0].startsWith('restauracao-'));
  assert.ok(!stageNames.includes('active.sqlite'));
 } finally {
  if (previous === undefined) delete process.env.PAINEL_DB_PATH; else process.env.PAINEL_DB_PATH = previous;
  rmSync(f.directory, { recursive: true, force: true });
 }
});
