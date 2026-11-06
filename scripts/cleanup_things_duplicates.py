"""Reversible cleanup of unchanged, generated Things occurrences and a demo project."""
import argparse,datetime as dt,json,sqlite3
from pathlib import Path


def unchanged_generated(task,schedule):
    if task.get('done') or task.get('sourceId') or task.get('previousId') or task.get('successorId') or 'position' in task:return False
    if task.get('plannedDate')!=task.get('scheduledFor'):return False
    try:
        created=dt.datetime.fromisoformat(task['createdAt'].replace('Z','+00:00'))
        updated=dt.datetime.fromisoformat(task['updatedAt'].replace('Z','+00:00'))
        if not 0 <= (updated-created).total_seconds() <= .1:return False
        day=dt.date.fromisoformat(task['scheduledFor'])
    except (KeyError,ValueError,TypeError):return False
    for key in ('title','notes','areaId','projectId','headingId'):
        if task.get(key)!=schedule.get(key):return False
    if sorted(task.get('tagIds',[]))!=sorted(schedule.get('tagIds',[])):return False
    expected=[dict(text=item['text'],done=False) for item in schedule.get('checklist',[])]
    if task.get('checklist')!=expected:return False
    offset=schedule.get('deadlineOffset')
    deadline=(day+dt.timedelta(days=offset)).isoformat() if offset is not None else None
    if task.get('deadline')!=deadline:return False
    reminder=schedule.get('reminderTime')
    if reminder:
        expected=dt.datetime.fromisoformat(day.isoformat()+'T'+reminder+'-03:00')
        try:
            if dt.datetime.fromisoformat(task['reminderAt'].replace('Z','+00:00'))!=expected:return False
        except (KeyError,ValueError,TypeError):return False
    elif task.get('reminderAt') is not None:return False
    return True


def candidates(rows,schedules,today):
    dt.date.fromisoformat(today)
    remove=[]
    for schedule_id,schedule in schedules.items():
        past=[(id,t) for id,t in rows if t.get('scheduleId')==schedule_id and not t.get('done') and isinstance(t.get('scheduledFor'),str) and t['scheduledFor']<=today]
        if len(past)<2:continue
        safe=[(id,t) for id,t in past if unchanged_generated(t,schedule)]
        protected=[(id,t) for id,t in past if not unchanged_generated(t,schedule)]
        keep=None if protected else max(safe,key=lambda pair:(pair[1]['scheduledFor'],pair[0]))[0]
        remove.extend(id for id,t in safe if id!=keep)
    return remove


def clean(path,today,apply=False):
    path=Path(path).resolve(strict=True)
    db=sqlite3.connect(path.as_uri()+('?mode=rw' if apply else '?mode=ro'),uri=True);db.row_factory=sqlite3.Row
    try:
        if apply:db.execute('BEGIN IMMEDIATE')
        rows=[(row['id'],json.loads(row['body'])) for row in db.execute('SELECT id,body FROM tasks')]
        schedules={row['id']:json.loads(row['body']) for row in db.execute('SELECT id,body FROM recurring_schedules')}
        imported={id:s for id,s in schedules.items() if str(s.get('sourceId','')).startswith('things:')}
        remove=candidates(rows,imported,today)
        pause=[id for id,s in imported.items() if not s['rule'].get('paused')]
        project=db.execute("SELECT p.* FROM projects p JOIN areas a ON a.id=p.area_id WHERE p.source_id IS NULL AND p.name='Proposta comercial' COLLATE NOCASE AND a.name='Trabalho' COLLATE NOCASE").fetchone()
        summary=dict(generatedOccurrencesToQuarantine=len(remove),importedSchedulesToPause=len(pause),demoProjectsToRemove=int(project is not None),completedTasksToRemove=0,sourceTasksToRemove=0)
        if not apply:return summary
        db.execute('CREATE TABLE IF NOT EXISTS things_cleanup_archive(kind TEXT NOT NULL,row_id INTEGER NOT NULL,body TEXT NOT NULL,archived_at TEXT NOT NULL,PRIMARY KEY(kind,row_id))')
        now=dt.datetime.now(dt.timezone.utc).isoformat()
        def archive(kind,id,body):db.execute('INSERT OR IGNORE INTO things_cleanup_archive VALUES (?,?,?,?)',(kind,id,json.dumps(body,ensure_ascii=False),now))
        for id,task in rows:
            if id in remove:
                archive('generated_task',id,task);db.execute('DELETE FROM tasks WHERE id=?',(id,))
        for id in pause:
            s=imported[id];archive('schedule_before_pause',id,s)
            s['rule']['paused']=True
            db.execute('UPDATE recurring_schedules SET body=? WHERE id=?',(json.dumps(s,ensure_ascii=False),id))
        if project:
            pid=project['id'];area=project['area_id'];area_name=db.execute('SELECT name FROM areas WHERE id=?',(area,)).fetchone()[0]
            archive('demo_project',pid,dict(project))
            for h in db.execute('SELECT * FROM headings WHERE project_id=?',(pid,)).fetchall():archive('demo_heading',h['id'],dict(h))
            for table in ('tasks','recurring_schedules'):
                for row in db.execute('SELECT id,body FROM '+table).fetchall():
                    body=json.loads(row['body'])
                    if body.get('projectId')!=pid:continue
                    archive(table+'_before_project_removal',row['id'],body)
                    body.update(projectId=None,headingId=None,areaId=area)
                    body['tagIds']=list(dict.fromkeys(body.get('tagIds',[])+json.loads(project['tag_ids'])))
                    if table=='tasks':body.update(project=area_name,projectName=None,areaName=area_name)
                    db.execute('UPDATE '+table+' SET body=? WHERE id=?',(json.dumps(body,ensure_ascii=False),row['id']))
            db.execute('DELETE FROM headings WHERE project_id=?',(pid,))
            db.execute('DELETE FROM projects WHERE id=?',(pid,))
        if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Integrity verification failed')
        db.commit()
        return summary
    except BaseException:
        if apply:db.rollback()
        raise
    finally:db.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',required=True)
    parser.add_argument('--day',required=True)
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    print(json.dumps(clean(args.database,args.day,args.apply)))
