import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventInputError, validateEventInput, type ManualEvent } from './events.ts';
import { validDate } from './task-dates.ts';

export function openEventStore(path: string) {
 mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
 const db = new DatabaseSync(path);
 try {
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS manual_events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, date TEXT NOT NULL, time TEXT NULL); CREATE INDEX IF NOT EXISTS manual_events_by_date ON manual_events(date, time, id); CREATE TABLE IF NOT EXISTS manual_event_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare("INSERT OR IGNORE INTO manual_event_metadata(key,value) VALUES ('schema_version','1')").run();
 } catch (error) { db.close(); throw error; }
 const fromRow = (row: Record<string, unknown>): ManualEvent => ({ id: Number(row.id), title: String(row.title), date: String(row.date), time: row.time === null ? null : String(row.time) });
 return {
  list(date: string): ManualEvent[] {
   if (!validDate(date)) throw new EventInputError('Informe uma data válida no formato AAAA-MM-DD.');
   return db.prepare('SELECT id,title,date,time FROM manual_events WHERE date=? ORDER BY CASE WHEN time IS NULL THEN 0 ELSE 1 END, time, id').all(date).map(fromRow);
  },
  create(input: unknown): ManualEvent {
   const value = validateEventInput(input) as Omit<ManualEvent, 'id'>;
   const result = db.prepare('INSERT INTO manual_events(title,date,time) VALUES (?,?,?)').run(value.title, value.date, value.time);
   return { id: Number(result.lastInsertRowid), ...value };
  },
  update(id: number, input: unknown): ManualEvent | undefined {
   const patch = validateEventInput(input, true) as Partial<Omit<ManualEvent, 'id'>>;
   const current = db.prepare('SELECT id,title,date,time FROM manual_events WHERE id=?').get(id);
   if (!current) return undefined;
   const event = { ...fromRow(current), ...patch };
   db.prepare('UPDATE manual_events SET title=?, date=?, time=? WHERE id=?').run(event.title, event.date, event.time, id);
   return event;
  },
  remove(id: number): boolean { return db.prepare('DELETE FROM manual_events WHERE id=?').run(id).changes > 0; },
  close() { db.close(); },
 };
}
