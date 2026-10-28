import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initialBrief, type Briefing, validBriefingDate, validateBriefingInput } from './briefing.ts';

export function openBriefStore(path: string) {
 mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
 const db = new DatabaseSync(path);
 try {
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS briefings (date TEXT PRIMARY KEY, hoje TEXT NOT NULL, pendencias TEXT NOT NULL, semana TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS briefing_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  db.exec('BEGIN IMMEDIATE');
  try {
   const seeded = db.prepare("SELECT value FROM briefing_metadata WHERE key='initial_briefing_seeded'").get();
   if (!seeded) {
    db.prepare('INSERT OR IGNORE INTO briefings(date, hoje, pendencias, semana, updated_at) VALUES (?, ?, ?, ?, ?)')
     .run(initialBrief.date, initialBrief.Hoje, initialBrief.Pendências, initialBrief.Semana, '');
    db.prepare("INSERT INTO briefing_metadata(key, value) VALUES ('initial_briefing_seeded', '1')").run();
   }
   db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
 } catch (error) { db.close(); throw error; }

 function fromRow(row: Record<string, unknown>): Briefing {
  return { date: String(row.date), Hoje: String(row.hoje), Pendências: String(row.pendencias), Semana: String(row.semana), updatedAt: String(row.updated_at) };
 }
 return {
  list(): Array<Pick<Briefing, 'date' | 'updatedAt'>> {
   return db.prepare('SELECT date, updated_at FROM briefings ORDER BY date DESC').all()
    .map(row => ({ date: String(row.date), updatedAt: String(row.updated_at) }));
  },
  get(date: string): Briefing | undefined {
   if (!validBriefingDate(date)) return undefined;
   const row = db.prepare('SELECT date, hoje, pendencias, semana, updated_at FROM briefings WHERE date=?').get(date);
   return row ? fromRow(row) : undefined;
  },
  save(date: string, content: Pick<Briefing, 'Hoje' | 'Pendências' | 'Semana'>): Briefing {
   if (!validBriefingDate(date)) throw new TypeError('Data inválida. Use o formato AAAA-MM-DD.');
   content = validateBriefingInput(content);
   const updatedAt = new Date().toISOString();
   db.prepare(`INSERT INTO briefings(date, hoje, pendencias, semana, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET hoje=excluded.hoje, pendencias=excluded.pendencias, semana=excluded.semana, updated_at=excluded.updated_at`)
    .run(date, content.Hoje, content.Pendências, content.Semana, updatedAt);
   return { date, ...content, updatedAt };
  },
  close() { db.close(); },
 };
}
