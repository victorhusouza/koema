import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { localDay, validDate } from '../lib/task-dates.ts';
import { nextCalendarDate, validateRecurrenceRule } from '../lib/recurrence.ts';
import type { RecurringSchedule } from '../lib/task-store.ts';

/** Restore only temporary cleanup pauses; never recreate or delete tasks. */
export function resumeImportedSchedules(path: string, day: string, apply = false) {
  if (!validDate(day)) throw new Error('Invalid resume date');
  const db = new DatabaseSync(realpathSync(path), { readOnly: !apply });
  let transaction = false;
  const result = { resumed: 0, expired: 0, changed: 0, alreadyProcessed: 0, apply };
  try {
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 7) throw new Error('Schema version 7 required');
    if (apply) { db.exec('BEGIN IMMEDIATE'); transaction = true; }
    const tableExists = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    if (!tableExists('things_cleanup_archive')) { if (apply) db.exec('COMMIT'); return result; }
    if (apply) db.exec('CREATE TABLE IF NOT EXISTS things_schedule_resume_runs(schedule_id INTEGER NOT NULL, archive_hash TEXT NOT NULL, resumed_at TEXT NOT NULL, PRIMARY KEY(schedule_id,archive_hash))');
    const archived = db.prepare("SELECT row_id,body FROM things_cleanup_archive WHERE kind='schedule_before_pause'").all();
    for (const row of archived) {
      const id = Number(row.row_id);
      const hash = createHash('sha256').update(String(row.body)).digest('hex');
      if (tableExists('things_schedule_resume_runs') && db.prepare('SELECT 1 FROM things_schedule_resume_runs WHERE schedule_id=? AND archive_hash=?').get(id, hash)) { result.alreadyProcessed++; continue; }
      const original = JSON.parse(String(row.body)) as RecurringSchedule;
      const saved = db.prepare('SELECT body FROM recurring_schedules WHERE id=?').get(id);
      if (!saved) continue;
      const current = JSON.parse(String(saved.body)) as RecurringSchedule;
      if (!original.sourceId?.startsWith('things:') || current.sourceId !== original.sourceId || original.rule.paused || !current.rule.paused) continue;
      const fields = ['mode','unit','interval','anchorDate','weekdays','monthDays','ordinalWeekdays','months','endDate'] as const;
      if (fields.some(key => JSON.stringify(current.rule[key] ?? null) !== JSON.stringify(original.rule[key] ?? null))) { result.changed++; continue; }
      const rule = validateRecurrenceRule({ ...current.rule, paused: false });
      if (rule.mode !== 'calendar') { result.changed++; continue; }
      if (rule.endDate && rule.endDate < day) { result.expired++; continue; }
      const next = nextCalendarDate(rule, day, true);
      if (next === null) { result.expired++; continue; }
      if (apply) {
        db.prepare('UPDATE recurring_schedules SET body=?,next_occurrence_date=? WHERE id=?').run(JSON.stringify({ ...current, rule, nextOccurrenceDate: next }), next, id);
        db.prepare('INSERT INTO things_schedule_resume_runs VALUES (?,?,?)').run(id, hash, new Date().toISOString());
      }
      result.resumed++;
    }
    if (apply) db.exec('COMMIT');
    return result;
  } catch (error) { if (transaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--database');
  const path = index >= 0 ? process.argv[index + 1] : undefined;
  if (!path) throw new Error('Use --database PATH [--apply]');
  console.log(JSON.stringify(resumeImportedSchedules(path, localDay(new Date()), process.argv.includes('--apply'))));
}
