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

function fixture() {
 const directory = mkdtempSync(join(tmpdir(), 'koema-backup-test-'));
 const path = join(directory, 'active.sqlite');
 const tasks = openTaskStore(path, { now: () => new Date('2026-10-28T12:00:00Z') });
 const area = tasks.createArea({ name: 'Teste' });
 const project = tasks.createProject({ areaId: area.id, name: 'Projeto fictício' });
 tasks.create({ title: 'Tarefa fictícia', when: 'Hoje', plannedDate: '2026-10-28', areaId: area.id, projectId: project.id, recurrence: 'weekly' });
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
  assert.deepEqual(result.info.counts, { tasks: 12, areas: 3, projects: 2, briefings: 2, manualEvents: 1 });
  // Read the returned portable image through a private temporary file.
  const snapshotPath = join(f.directory, 'export.sqlite'); writeFileSync(snapshotPath, result.bytes);
  const copy = new DatabaseSync(snapshotPath);
  const names = (copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row => row.name);
  assert.ok(!names.includes('google_calendar_metadata'));
  assert.ok(names.includes('briefing_metadata'));
  assert.ok(names.includes('manual_event_metadata'));
  assert.equal((copy.prepare("SELECT value FROM koema_backup_metadata WHERE key='format_version'").get() as {value:string}).value, '1');
  copy.close();
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
 } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('upload ignores client filenames and enforces origin and multipart content type', async () => {
 const f = fixture();
 const previous = process.env.PAINEL_DB_PATH;
 process.env.PAINEL_DB_PATH = f.path;
 try {
  const portable = (await createPortableBackup(f.path, f.directory)).bytes;
  const denied = await backupPost(new Request('http://127.0.0.1:3000/api/backup', { method: 'POST', headers: { host: '127.0.0.1:3000', 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(denied.status, 403);
  const exported = await backupPost(new Request('http://127.0.0.1:3000/api/backup', { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(exported.status, 200);
  assert.ok(Buffer.from(await exported.arrayBuffer()).subarray(0, 16).equals(Buffer.from('SQLite format 3\0')));
  const wrongType = await backupPost(new Request('http://127.0.0.1:3000/api/backup', { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'text/plain' }, body: '{}' }));
  assert.equal(wrongType.status, 415);
  let generated = 0;
  const oversizedBody = new ReadableStream<Uint8Array>({ pull(controller) { if (generated++ >= 65) controller.close(); else controller.enqueue(new Uint8Array(1024 * 1024)); } });
  const oversized = await backupPost(new Request('http://127.0.0.1:3000/api/backup', { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'multipart/form-data; boundary=unused', 'content-length': '1' }, body: oversizedBody, duplex: 'half' } as RequestInit & { duplex: 'half' }));
  assert.equal(oversized.status, 413);
  const form = new FormData(); form.set('backup', new File([new Uint8Array(portable)], '../../active.sqlite'));
  const restored = await backupPost(new Request('http://127.0.0.1:3000/api/backup', { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-length': String(portable.length + 1024) }, body: form }));
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
