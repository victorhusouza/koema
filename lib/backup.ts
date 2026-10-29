import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { validDate } from './task-dates.ts';

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const APP_VERSION = '0.1.0';
const MAX_SCHEMA_VERSION = 6;
const MAX_OPERATION_MS = 30_000;
const INCLUDED_TABLES = new Set(['tasks', 'areas', 'projects', 'briefings', 'briefing_metadata', 'manual_events', 'manual_event_metadata', 'koema_backup_metadata']);
const REQUIRED_TABLES = ['tasks', 'areas', 'projects'];
const EXPECTED_COLUMNS: Record<string, Array<[string, string, number]>> = {
 tasks: [['id','INTEGER',1], ['body','TEXT',0]], areas: [['id','INTEGER',1], ['name','TEXT',0]],
 projects: [['id','INTEGER',1], ['area_id','INTEGER',0], ['name','TEXT',0], ['status','TEXT',0], ['completed_at','TEXT',0]],
 briefings: [['date','TEXT',1], ['hoje','TEXT',0], ['pendencias','TEXT',0], ['semana','TEXT',0], ['updated_at','TEXT',0]],
 briefing_metadata: [['key','TEXT',1], ['value','TEXT',0]], manual_events: [['id','INTEGER',1], ['title','TEXT',0], ['date','TEXT',0], ['time','TEXT',0]],
 manual_event_metadata: [['key','TEXT',1], ['value','TEXT',0]], koema_backup_metadata: [['key','TEXT',1], ['value','TEXT',0]],
};
export type BackupCounts = { tasks: number; areas: number; projects: number; briefings: number; manualEvents: number };
export type BackupInfo = { createdAt: string; appVersion: string; schemaVersion: number; counts: BackupCounts };

function tables(db: DatabaseSync): Set<string> {
 return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(row => row.name));
}
function counts(db: DatabaseSync, present = tables(db)): BackupCounts {
 const count = (table: string) => present.has(table) ? Number((db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {count:number}).count) : 0;
 return { tasks: count('tasks'), areas: count('areas'), projects: count('projects'), briefings: count('briefings'), manualEvents: count('manual_events') };
}
function validateDatabase(db: DatabaseSync): { version: number; present: Set<string> } {
 db.exec('PRAGMA trusted_schema=OFF;');
 const integrity = db.prepare('PRAGMA integrity_check').all() as {integrity_check:string}[];
 if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('O arquivo não passou na verificação de integridade do SQLite.');
 const version = Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
 if (!Number.isInteger(version) || version < 1 || version > MAX_SCHEMA_VERSION) throw new Error('A versão do banco não é compatível com esta versão do Koema.');
 const present = tables(db);
 if (REQUIRED_TABLES.some(table => !present.has(table))) throw new Error('O arquivo não contém as tabelas principais do Koema.');
 for (const table of present) if (!INCLUDED_TABLES.has(table)) throw new Error('O arquivo contém tabelas que o Koema não reconhece.');
 if (present.size < 3) throw new Error('O arquivo não contém as tabelas principais do Koema.');
 const unsafeObjects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('view','trigger') OR type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all();
 if (unsafeObjects.length) throw new Error('O arquivo contém objetos de banco não permitidos.');
 for (const table of present) {
  const columns = (db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as {name:string;type:string;pk:number}[]).map(column => [column.name, column.type.toUpperCase(), Number(column.pk)]);
  if (JSON.stringify(columns) !== JSON.stringify(EXPECTED_COLUMNS[table])) throw new Error('O esquema de uma tabela não corresponde ao Koema.');
 }
 if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('O arquivo contém referências quebradas entre registros.');
 const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(index => index.name);
 if (indexNames.some(name => !['tasks_area_id','tasks_project_id','tasks_one_open_per_series','manual_events_by_date'].includes(name))) throw new Error('O arquivo contém índices não reconhecidos.');
 validateRecords(db, present);
 return { version, present };
}
function validateRecords(db: DatabaseSync, present: Set<string>) {
 const areaIds = new Set(present.has('areas') ? (db.prepare('SELECT id FROM areas').all() as {id:number}[]).map(row => Number(row.id)) : []);
 const projects = new Map(present.has('projects') ? (db.prepare('SELECT id,area_id FROM projects').all() as {id:number;area_id:number}[]).map(row => [Number(row.id), Number(row.area_id)]) : []);
 for (const row of db.prepare('SELECT id,body FROM tasks').all() as {id:number;body:string}[]) {
  let task: Record<string, unknown>;
  try { task = JSON.parse(row.body); } catch { throw new Error('O arquivo contém uma tarefa inválida.'); }
  if (!task || Array.isArray(task) || typeof task !== 'object' || typeof task.title !== 'string' || !task.title.trim() || typeof task.done !== 'boolean' || typeof task.when !== 'string' || !Array.isArray(task.checklist) || task.checklist.some(item => !item || typeof item.text !== 'string' || typeof item.done !== 'boolean')) throw new Error('O arquivo contém uma tarefa inválida.');
  if (task.plannedDate != null && !validDate(task.plannedDate) || task.deadline != null && !validDate(task.deadline)) throw new Error('O arquivo contém uma data de tarefa inválida.');
  if (task.recurrence != null && !['daily','weekly','monthly'].includes(String(task.recurrence))) throw new Error('O arquivo contém uma repetição inválida.');
  if (task.areaId != null && (!Number.isSafeInteger(task.areaId) || !areaIds.has(Number(task.areaId)))) throw new Error('Uma tarefa aponta para uma área inexistente.');
  if (task.projectId != null && (!Number.isSafeInteger(task.projectId) || !projects.has(Number(task.projectId)))) throw new Error('Uma tarefa aponta para um projeto inexistente.');
 }
 if (present.has('briefings')) for (const row of db.prepare('SELECT date,hoje,pendencias,semana,updated_at FROM briefings').all() as Record<string,unknown>[]) {
  if (typeof row.date !== 'string' || !validDate(row.date) || ['hoje','pendencias','semana','updated_at'].some(field => typeof row[field] !== 'string')) throw new Error('O arquivo contém um briefing inválido.');
 }
 if (present.has('manual_events')) for (const row of db.prepare('SELECT title,date,time FROM manual_events').all() as Record<string,unknown>[]) {
  if (typeof row.title !== 'string' || typeof row.date !== 'string' || !validDate(row.date) || (row.time !== null && (typeof row.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.time)))) throw new Error('O arquivo contém um compromisso inválido.');
 }
}

/** Creates a transactionally consistent SQLite snapshot and strips calendar secrets. */
export async function createPortableBackup(activePath: string, tempRoot = tmpdir()): Promise<{ bytes: Buffer; info: BackupInfo }> {
 const directory = mkdtempSync(join(tempRoot, 'koema-export-'));
 chmodSync(directory, 0o700);
 const snapshotPath = join(directory, 'snapshot.sqlite');
 let source: DatabaseSync | undefined;
 let snapshot: DatabaseSync | undefined;
 try {
  source = new DatabaseSync(activePath, { readOnly: true });
  const deadline = Date.now() + MAX_OPERATION_MS;
  await backup(source, snapshotPath, { progress: () => { if (Date.now() > deadline) throw new Error('A exportação excedeu o limite de 30 segundos.'); } });
  source.close(); source = undefined;
  snapshot = new DatabaseSync(snapshotPath);
  snapshot.exec('PRAGMA secure_delete=ON; PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  try {
   const present = tables(snapshot);
   for (const name of present) if (!INCLUDED_TABLES.has(name)) snapshot.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
   const objects = snapshot.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('trigger','view')").all() as {type:string;name:string}[];
   for (const object of objects) snapshot.exec(`DROP ${object.type.toUpperCase()} "${object.name.replaceAll('"', '""')}"`);
   if (tables(snapshot).has('koema_backup_metadata')) snapshot.exec('DROP TABLE koema_backup_metadata');
   snapshot.exec('COMMIT;');
  } catch (error) { snapshot.exec('ROLLBACK;'); throw error; }
  snapshot.exec('VACUUM;');
  const checked = validateDatabase(snapshot);
  const info: BackupInfo = { createdAt: new Date().toISOString(), appVersion: APP_VERSION, schemaVersion: checked.version, counts: counts(snapshot, checked.present) };
  snapshot.exec('CREATE TABLE koema_backup_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  snapshot.prepare('INSERT INTO koema_backup_metadata(key,value) VALUES (?,?)').run('format_version', '1');
  snapshot.prepare('INSERT INTO koema_backup_metadata(key,value) VALUES (?,?)').run('backup_info', JSON.stringify(info));
  snapshot.close(); snapshot = undefined;
  const bytes = readFileSync(snapshotPath);
  if (bytes.length > MAX_BACKUP_BYTES) throw new Error('O banco ultrapassa o limite de 64 MB para exportação.');
  return { bytes, info };
 } finally {
  try { source?.close(); } catch {}
  try { snapshot?.close(); } catch {}
  rmSync(directory, { recursive: true, force: true });
 }
}

/** Validates an uploaded portable database, then stores it at a unique server-chosen path. */
export async function restoreToSeparateDatabase(bytes: Buffer, activePath: string): Promise<{ info: BackupInfo; storageLabel: string }> {
 if (bytes.byteLength > MAX_BACKUP_BYTES) throw new Error('O arquivo ultrapassa o limite de 64 MB.');
 if (bytes.byteLength < 100 || !bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new Error('O arquivo não é um banco SQLite válido.');
 const parent = dirname(activePath);
 const stagingDirectory = join(parent, 'restored-backups');
 mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
 chmodSync(stagingDirectory, 0o700);
 const directory = mkdtempSync(join(tmpdir(), 'koema-import-'));
 chmodSync(directory, 0o700);
 const sourcePath = join(directory, 'upload.sqlite');
 const stagedPath = join(stagingDirectory, `restauracao-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`);
 writeFileSync(sourcePath, bytes, { mode: 0o600, flag: 'wx' });
 let source: DatabaseSync | undefined;
 let destination: DatabaseSync | undefined;
 try {
  source = new DatabaseSync(sourcePath, { readOnly: true });
  const checked = validateDatabase(source);
  const metadata = checked.present.has('koema_backup_metadata')
   ? source.prepare("SELECT value FROM koema_backup_metadata WHERE key='backup_info'").get() as {value:string} | undefined
   : undefined;
  const formatVersion = checked.present.has('koema_backup_metadata') ? source.prepare("SELECT value FROM koema_backup_metadata WHERE key='format_version'").get() as {value:string} | undefined : undefined;
  if (!metadata || formatVersion?.value !== '1') throw new Error('O arquivo não contém os metadados de uma exportação Koema.');
  let info: BackupInfo;
  try { info = JSON.parse(metadata.value) as BackupInfo; } catch { throw new Error('Os metadados do arquivo estão inválidos.'); }
  if (!info || typeof info.createdAt !== 'string' || !Number.isInteger(info.schemaVersion) || !info.counts || info.schemaVersion !== checked.version || JSON.stringify(info.counts) !== JSON.stringify(counts(source, checked.present))) throw new Error('Os metadados do arquivo não correspondem aos dados.');
  const deadline = Date.now() + MAX_OPERATION_MS;
  await backup(source, stagedPath, { progress: () => { if (Date.now() > deadline) throw new Error('A verificação excedeu o limite de 30 segundos.'); } });
  source.close(); source = undefined;
  chmodSync(stagedPath, 0o600);
  destination = new DatabaseSync(stagedPath);
  const destinationCheck = validateDatabase(destination);
  const finalCounts = counts(destination, destinationCheck.present);
  if (JSON.stringify(finalCounts) !== JSON.stringify(info.counts)) throw new Error('A cópia restaurada não corresponde ao arquivo enviado.');
  destination.close(); destination = undefined;
  return { info, storageLabel: 'Pasta local de restaurações' };
 } catch (error) {
  rmSync(stagedPath, { force: true });
  rmSync(`${stagedPath}-wal`, { force: true });
  rmSync(`${stagedPath}-shm`, { force: true });
  throw error;
 } finally {
  try { source?.close(); } catch {}
  try { destination?.close(); } catch {}
  rmSync(directory, { recursive: true, force: true });
 }
}
