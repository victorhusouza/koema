import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeImportedSchedules } from '../scripts/resume-imported-schedules.ts';

test('resume restores only temporary pauses, skips expired or edited rules, and respects later user pauses',()=>{
 const dir=mkdtempSync(join(tmpdir(),'koema-resume-'));const path=join(dir,'fixture.sqlite');
 const db=new DatabaseSync(path);
 try{
  db.exec("CREATE TABLE recurring_schedules(id INTEGER PRIMARY KEY,body TEXT,next_occurrence_date TEXT);CREATE TABLE things_cleanup_archive(kind TEXT,row_id INTEGER,body TEXT);PRAGMA user_version=7;");
  for(let id=1;id<=4;id++){
   const rule={mode:'calendar',unit:'month',interval:1,anchorDate:'2026-01-01',ordinalWeekdays:[{weekday:6,ordinal:1}],paused:id===2,...(id===3?{endDate:'2026-10-01'}:{})};
   const original={id,sourceId:`things:fixture-${id}`,rule,nextOccurrenceDate:null};
   db.prepare('INSERT INTO things_cleanup_archive VALUES (?,?,?)').run('schedule_before_pause',id,JSON.stringify(original));
   db.prepare('INSERT INTO recurring_schedules VALUES (?,?,NULL)').run(id,JSON.stringify({...original,rule:{...rule,paused:true,interval:id===4?2:1}}));
  }
  assert.equal(resumeImportedSchedules(path,'2026-11-06').resumed,1);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='things_schedule_resume_runs'").get(),undefined);
  const result=resumeImportedSchedules(path,'2026-11-06',true);
  assert.equal(result.resumed,1);assert.equal(result.expired,1);assert.equal(result.changed,1);
  const body=JSON.parse(String(db.prepare('SELECT body FROM recurring_schedules WHERE id=1').get()!.body));
  assert.equal(body.nextOccurrenceDate,'2026-11-07');
  body.rule.paused=true;db.prepare('UPDATE recurring_schedules SET body=? WHERE id=1').run(JSON.stringify(body));
  assert.equal(resumeImportedSchedules(path,'2026-11-06',true).resumed,0);
  assert.equal(JSON.parse(String(db.prepare('SELECT body FROM recurring_schedules WHERE id=1').get()!.body)).rule.paused,true);
  assert.equal(JSON.parse(String(db.prepare('SELECT body FROM recurring_schedules WHERE id=2').get()!.body)).rule.paused,true);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
