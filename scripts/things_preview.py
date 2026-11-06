"""Offline Things preview. Reads only a whitelist; never connects to a server."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess
from zoneinfo import ZoneInfo


def civil(value):
    if value is None or value == 0:
        return None
    if not isinstance(value, int) or value < 0:
        raise ValueError('Invalid packed date')
    year, month, day = value >> 16, (value >> 12) & 15, (value >> 7) & 31
    if year == 4001:  # Things uses an out-of-range sentinel for unset deadlines.
        return None
    if value & 127 or not 1 <= year <= 3999:
        raise ValueError('Unrecognized packed date')
    return dt.date(year, month, day).isoformat()


def clock(value):
    if value is None:
        return None
    if not isinstance(value, int) or value < 0 or value & ((1 << 20)-1):
        raise ValueError('Invalid packed reminder')
    hour, minute = value >> 26, (value >> 20) & 63
    if hour > 23 or minute > 59:
        raise ValueError('Invalid reminder clock')
    return f'{hour:02}:{minute:02}'


def instant(value):
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat().replace('+00:00', 'Z') if value is not None else None


def source_day(value):
    if value is None:
        return None
    day = dt.datetime.fromtimestamp(value, dt.timezone.utc).date()
    return None if day.year == 4001 else day.isoformat()


def rule(raw, paused, confirmed_ordinal=False):
    if raw.get('rrv') != 4 or raw.get('tp') != 0 or raw.get('rc') != 0 or raw.get('ts') != 0:
        raise ValueError('Unrecognized recurrence mode/version/count')
    if set(raw) - {'rrv','tp','rc','ts','ed','ia','sr','fa','fu','of'}:
        raise ValueError('Unrecognized recurrence fields')
    anchor = source_day(raw['ia'])
    interval = raw['fa']
    if not anchor or not isinstance(interval, int) or interval < 1:
        raise ValueError('Invalid recurrence anchor or interval')
    output = dict(mode='calendar', interval=interval, anchorDate=anchor,
                  paused=bool(paused), endDate=source_day(raw.get('ed')))
    offsets = raw['of']
    if raw['fu'] == 16 and offsets == [{'dy': 0}]:
        output['unit'] = 'day'
    elif raw['fu'] == 256 and offsets and all(set(x) == {'wd'} and isinstance(x['wd'],int) and 0 <= x['wd'] <= 6 for x in offsets):
        output.update(unit='week', weekdays=sorted(set(x['wd'] for x in offsets)))
    elif raw['fu'] == 8 and offsets and all(set(x) == {'dy'} and isinstance(x['dy'],int) and -1 <= x['dy'] <= 30 for x in offsets):
        output.update(unit='month', monthDays=[-1 if x['dy'] == -1 else x['dy']+1 for x in offsets])
    elif confirmed_ordinal and raw['fu'] == 8 and offsets == [{'wd': 6, 'wdo': 1}]:
        output.update(unit='month', ordinalWeekdays=[dict(weekday=6,ordinal=1)])
    else:
        raise ValueError('Recurrence offsets require manual validation')
    return output


def placement(start, bucket, planned, today):
    if bucket not in (0, 1) or start not in (0, 1, 2):
        raise ValueError('Unrecognized source placement')
    if start == 0:
        return 'Caixa de entrada', None
    if planned and planned > today:
        return 'Planejada', planned
    if bucket == 1 or planned:
        return 'Hoje', today
    return 'Algum dia', None


def capital(text):
    if not text or text[0].isdigit() or len(text)>1 and text[1].isupper():
        return text
    return text[0].upper()+text[1:]


def preview(source, output, today, timezone='America/Belem', confirmed_modes=None, confirmed_ordinals=None):
    confirmed_ordinals = set(confirmed_ordinals or [])
    confirmed_modes = confirmed_modes or {}
    if any(mode != 'calendar' for mode in confirmed_modes.values()):
        raise ValueError('Only explicitly confirmed fixed-calendar modes are currently supported')
    dt.date.fromisoformat(today)
    zone = ZoneInfo(timezone)
    os.umask(0o077)
    output = Path(output).resolve()
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    source = Path(source).resolve(strict=True)
    db = sqlite3.connect(source.as_uri()+'?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise ValueError('Source integrity check failed')
    # Never SELECT *: sync settings, authentication tokens and experimental blobs stay out.
    fields = 'uuid,title,notes,type,status,trashed,creationDate,userModificationDate,stopDate,start,startBucket,startDate,deadline,reminderTime,"index",area,project,heading,rt1_repeatingTemplate,rt1_recurrenceRule,rt1_instanceCreationPaused,rt1_nextInstanceStartDate'
    rows = [dict(row) for row in db.execute('SELECT '+fields+' FROM TMTask WHERE trashed=0 ORDER BY "index",uuid')]
    areas = [dict(row) for row in db.execute('SELECT uuid,title,"index" FROM TMArea ORDER BY "index",uuid')]
    tags = [dict(row) for row in db.execute('SELECT uuid,title,parent,shortcut,"index" FROM TMTag ORDER BY "index",uuid')]
    checklists = {}
    for row in db.execute('SELECT task,title,status FROM TMChecklistItem ORDER BY "index",uuid'):
        if row['status'] not in (0,3): raise ValueError('Unsupported checklist status')
        checklists.setdefault(row['task'],[]).append(dict(text=capital(row['title'] or ''),done=row['status']==3))
    task_tags = {}
    for row in db.execute('SELECT tasks,tags FROM TMTaskTag'):
        task_tags.setdefault(row[0],[]).append(row[1])
    db.close()
    target = output/'koema-preview.sqlite'
    root = Path(__file__).resolve().parent.parent
    subprocess.run(['node','--experimental-strip-types','--input-type=module','-e',
        'import {openTaskStore} from "./lib/task-store.ts"; openTaskStore(process.argv[1]).close();',str(target)],cwd=root,check=True,capture_output=True)
    dest = sqlite3.connect(target)
    dest.execute('PRAGMA foreign_keys=ON')
    issues=[]
    for table in ['tasks','recurring_schedules','headings','projects','areas','tags']:
        dest.execute('DELETE FROM '+table)
    ids={}
    for pos,row in enumerate(tags,1):
        ids[row['uuid']]=pos
        dest.execute('INSERT INTO tags(id,name,shortcut,position,source_id) VALUES (?,?,?,?,?)',(pos,capital(row['title']),row['shortcut'] or None,pos,'things:'+row['uuid']))
    for row in tags:
        if row['parent']: dest.execute('UPDATE tags SET parent_id=? WHERE id=?',(ids[row['parent']],ids[row['uuid']]))
    tag_ids=lambda row:[ids[tag] for tag in task_tags.get(row['uuid'],[])]
    for pos,row in enumerate(areas,1):
        ids[row['uuid']]=pos
        dest.execute('INSERT INTO areas(id,name,position,source_id) VALUES (?,?,?,?)',(pos,capital(row['title']),pos,'things:'+row['uuid']))
    projects=[r for r in rows if r['type']==1]
    for pos,row in enumerate(projects,1):
        ids[row['uuid']]=pos
        dest.execute('INSERT INTO projects(id,area_id,name,notes,planned_date,deadline,position,tag_ids,source_id) VALUES (?,?,?,?,?,?,?,?,?)',
            (pos,ids.get(row['area']),capital(row['title']),row['notes'] or '',civil(row['startDate']),civil(row['deadline']),pos,json.dumps(tag_ids(row)),'things:'+row['uuid']))
    for pos,row in enumerate([r for r in rows if r['type']==2],1):
        ids[row['uuid']]=pos
        dest.execute('INSERT INTO headings(id,project_id,title,position,source_id) VALUES (?,?,?,?,?)',(pos,ids[row['project']],capital(row['title'] or ''),pos,'things:'+row['uuid']))
    schedules=[]
    schedule_ids={}
    schedule_review=[]
    for row in [r for r in rows if r['rt1_recurrenceRule'] is not None]:
        try: converted=rule(plistlib.loads(row['rt1_recurrenceRule']),row['rt1_instanceCreationPaused'],'things:'+row['uuid'] in confirmed_ordinals)
        except (ValueError,KeyError) as error:
            issues.append(dict(sourceId='things:'+row['uuid'],title=row['title'],reason=str(error)))
            continue
        schedule=dict(id=len(schedules)+1,title=capital(row['title']),notes=row['notes'] or '',checklist=checklists.get(row['uuid'],[]),
            areaId=ids.get(row['area']),projectId=ids.get(row['project']),headingId=ids.get(row['heading']),tagIds=tag_ids(row),
            deadlineOffset=None,reminderTime=clock(row['reminderTime']),rule=converted,nextOccurrenceDate=civil(row['rt1_nextInstanceStartDate']),sourceId='things:'+row['uuid'])
        # Preview only: the scheduler is never started against this database.
        dest.execute('INSERT INTO recurring_schedules(id,body,next_occurrence_date) VALUES (?,?,?)',(schedule['id'],json.dumps(schedule),schedule['nextOccurrenceDate']))
        schedules.append(schedule)
        schedule_review.append(dict(sourceId=schedule['sourceId'],title=schedule['title'],modeConfirmed=confirmed_modes.get(schedule['sourceId'])=='calendar',sourceNextDate=schedule['nextOccurrenceDate'],rule=converted))
        schedule_ids[row['uuid']]=schedule['id']
    for pos,row in enumerate([r for r in rows if r['type']==0 and r['rt1_recurrenceRule'] is None],1):
        if row['status'] not in (0,3): raise ValueError('Unsupported task status')
        planned=civil(row['startDate'])
        when,date=placement(row['start'],row['startBucket'],planned,today)
        reminder=clock(row['reminderTime'])
        reminder_at=None
        if reminder and planned:
            reminder_at=dt.datetime.fromisoformat(planned+'T'+reminder).replace(tzinfo=zone).astimezone(dt.timezone.utc).isoformat().replace('+00:00','Z')
        elif reminder:
            issues.append(dict(sourceId='things:'+row['uuid'],title=row['title'],reason='Reminder has no explicit source date; original clock retained in review only',reminderTime=reminder))
        task=dict(id=pos,title=capital(row['title']),notes=row['notes'] or '',project='',when=when,plannedDate=planned if row['status']==3 else date,
            deadline=civil(row['deadline']),done=row['status']==3,checklist=checklists.get(row['uuid'],[]),completed=instant(row['stopDate']),
            createdAt=instant(row['creationDate']),updatedAt=instant(row['userModificationDate']),sourceId='things:'+row['uuid'],
            areaId=ids.get(row['area']),projectId=ids.get(row['project']),headingId=ids.get(row['heading']),tagIds=tag_ids(row),position=pos,
            reminderAt=reminder_at,scheduleId=None,scheduledFor=None)
        if row['rt1_repeatingTemplate']:
            task['scheduleId']=schedule_ids.get(row['rt1_repeatingTemplate'])
            task['scheduledFor']=planned if task['scheduleId'] else None
            if not task['scheduleId'] or not planned:
                issues.append(dict(sourceId=task['sourceId'],title=row['title'],reason='Occurrence/template association unresolved',templateSourceId='things:'+row['rt1_repeatingTemplate']))
            elif dest.execute("SELECT 1 FROM tasks WHERE json_extract(body,'$.scheduleId')=? AND json_extract(body,'$.scheduledFor')=?",(task['scheduleId'],planned)).fetchone():
                issues.append(dict(sourceId=task['sourceId'],title=row['title'],reason='Multiple source occurrences on the same schedule date; automatic linking refused'))
                task['scheduleId']=None
                task['scheduledFor']=None
        dest.execute('INSERT INTO tasks(id,body) VALUES (?,?)',(pos,json.dumps(task,ensure_ascii=False)))
    dest.commit()
    counts={table:dest.execute('SELECT count(*) FROM '+table).fetchone()[0] for table in ['tasks','areas','projects','headings','tags','recurring_schedules']}
    assert not dest.execute('PRAGMA foreign_key_check').fetchall()
    assert dest.execute('PRAGMA quick_check').fetchone()[0]=='ok'
    dest.close()
    unconfirmed=sum(not item['modeConfirmed'] for item in schedule_review)
    if unconfirmed:
        issues.append(dict(reason='Recurrence modes remain candidates until individually confirmed',count=unconfirmed))
    summary=dict(previewOnly=True,productionImportReady=False,counts=counts,issues=issues,scheduleReview=schedule_review,timezone=timezone,importDay=today,
        sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest())
    (output/'review.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    return summary

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True)
    parser.add_argument('--output',required=True,help='A NEW private directory; existing directories are refused')
    parser.add_argument('--day',required=True)
    parser.add_argument('--confirmed-modes',help='Private JSON mapping of exact source identifiers to user-confirmed modes')
    parser.add_argument('--confirmed-ordinals',help='Private JSON list of source identifiers confirmed as first Saturday')
    args=parser.parse_args()
    modes=json.loads(Path(args.confirmed_modes).read_text()) if args.confirmed_modes else {}
    ordinals=json.loads(Path(args.confirmed_ordinals).read_text()) if args.confirmed_ordinals else []
    result=preview(args.source,args.output,args.day,confirmed_modes=modes,confirmed_ordinals=ordinals)
    print(json.dumps(dict(counts=result['counts'],reviewIssues=len(result['issues']),productionImportReady=False)))
