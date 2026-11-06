"""Transactional merge of a reviewed Koema preview; never restores an entire database."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import sqlite3

TABLES=('tags','areas','projects','headings','recurring_schedules','tasks')


def merge(preview, target, source_sha, fail_after=None):
    if len(source_sha)!=64 or any(c not in '0123456789abcdef' for c in source_sha):
        raise ValueError('Invalid source fingerprint')
    preview=Path(preview).resolve(strict=True)
    target=Path(target).resolve(strict=True)
    if preview==target: raise ValueError('Source and destination must differ')
    package_sha=hashlib.sha256(preview.read_bytes()).hexdigest()
    src=sqlite3.connect(preview.as_uri()+'?mode=ro',uri=True);src.row_factory=sqlite3.Row
    dst=sqlite3.connect(target.as_uri()+'?mode=rw',uri=True);dst.row_factory=sqlite3.Row
    maps={table:{} for table in TABLES}
    counts={table:0 for table in TABLES}
    operations=0
    def tick():
        nonlocal operations
        operations+=1
        if fail_after is not None and operations>=fail_after: raise RuntimeError('Injected import failure')
    def ref(table,value):
        if value is None:return None
        if value not in maps[table]: raise ValueError('Unresolved '+table+' reference')
        return maps[table][value]
    def tags(value): return [ref('tags',tag) for tag in json.loads(value)]
    def sid(value):
        if not isinstance(value,str) or not value.startswith('things:') or len(value)>160:raise ValueError('Missing source identifier')
        return value
    try:
        for db in (src,dst):
            if db.execute('PRAGMA user_version').fetchone()[0]!=7:raise ValueError('Schema version 7 required')
            if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Database integrity check failed')
        dst.execute('PRAGMA foreign_keys=ON')
        dst.execute('PRAGMA busy_timeout=5000')
        dst.execute('BEGIN IMMEDIATE')
        dst.execute('CREATE TABLE IF NOT EXISTS things_import_runs(source_sha TEXT PRIMARY KEY,package_sha TEXT NOT NULL,imported_at TEXT NOT NULL,counts TEXT NOT NULL)')
        previous=dst.execute('SELECT package_sha FROM things_import_runs WHERE source_sha=?',(source_sha,)).fetchone()
        if previous:
            if previous['package_sha']!=package_sha:raise ValueError('The same source fingerprint has a different reviewed package')
            dst.rollback()
            return dict(alreadyImported=True,inserted=counts)
        # Establish all tag identifiers before connecting tag parents.
        new_tags=[]
        for row in src.execute('SELECT * FROM tags ORDER BY id'):
            existing=dst.execute('SELECT * FROM tags WHERE source_id=?',(sid(row['source_id']),)).fetchone()
            if not existing:existing=dst.execute('SELECT * FROM tags WHERE name=? COLLATE NOCASE',(row['name'],)).fetchone()
            if existing:
                if existing['source_id'] not in (None,row['source_id']):raise ValueError('Tag identity conflict')
                maps['tags'][row['id']]=existing['id']
                if existing['source_id'] is None:dst.execute('UPDATE tags SET source_id=? WHERE id=?',(row['source_id'],existing['id']))
            else:
                new=dst.execute('INSERT INTO tags(name,shortcut,position,source_id) VALUES (?,?,?,?)',(row['name'],row['shortcut'],row['position'],row['source_id'])).lastrowid
                maps['tags'][row['id']]=new;new_tags.append(row);counts['tags']+=1
            tick()
        for row in src.execute('SELECT * FROM tags'):
            parent=ref('tags',row['parent_id']);current=dst.execute('SELECT parent_id FROM tags WHERE id=?',(maps['tags'][row['id']],)).fetchone()[0]
            if row in new_tags:dst.execute('UPDATE tags SET parent_id=? WHERE id=?',(parent,maps['tags'][row['id']]))
            elif current!=parent:raise ValueError('Tag hierarchy conflict')
        for row in src.execute('SELECT * FROM areas ORDER BY id'):
            existing=dst.execute('SELECT * FROM areas WHERE source_id=?',(sid(row['source_id']),)).fetchone()
            if not existing:existing=dst.execute('SELECT * FROM areas WHERE name=? COLLATE NOCASE',(row['name'],)).fetchone()
            incoming=tags(row['tag_ids'])
            if existing:
                if existing['source_id'] not in (None,row['source_id']):raise ValueError('Area identity conflict')
                new=existing['id'];combined=list(dict.fromkeys(json.loads(existing['tag_ids'])+incoming))
                dst.execute('UPDATE areas SET source_id=?,tag_ids=? WHERE id=?',(row['source_id'],json.dumps(combined),new))
            else:
                new=dst.execute('INSERT INTO areas(name,position,tag_ids,source_id) VALUES (?,?,?,?)',(row['name'],row['position'],json.dumps(incoming),row['source_id'])).lastrowid;counts['areas']+=1
            maps['areas'][row['id']]=new;tick()
        for row in src.execute('SELECT * FROM projects ORDER BY id'):
            area=ref('areas',row['area_id'])
            existing=dst.execute('SELECT * FROM projects WHERE source_id=?',(sid(row['source_id']),)).fetchone()
            if not existing:
                collision=dst.execute('SELECT id FROM projects WHERE COALESCE(area_id,0)=COALESCE(?,0) AND name=? COLLATE NOCASE',(area,row['name'])).fetchone()
                if collision:raise ValueError('Existing project name conflicts with the import; manual review required')
                new=dst.execute('INSERT INTO projects(area_id,name,status,completed_at,notes,planned_date,deadline,position,tag_ids,source_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
                    (area,row['name'],row['status'],row['completed_at'],row['notes'],row['planned_date'],row['deadline'],row['position'],json.dumps(tags(row['tag_ids'])),row['source_id'])).lastrowid;counts['projects']+=1
            else:new=existing['id']
            maps['projects'][row['id']]=new;tick()
        for row in src.execute('SELECT * FROM headings ORDER BY id'):
            existing=dst.execute('SELECT id FROM headings WHERE source_id=?',(sid(row['source_id']),)).fetchone()
            if existing:new=existing['id']
            else:
                new=dst.execute('INSERT INTO headings(project_id,title,position,source_id) VALUES (?,?,?,?)',(ref('projects',row['project_id']),row['title'],row['position'],row['source_id'])).lastrowid;counts['headings']+=1
            maps['headings'][row['id']]=new;tick()
        for table in ('recurring_schedules','tasks'):
            for row in src.execute('SELECT id,body FROM '+table+' ORDER BY id'):
                body=json.loads(row['body']);source_id=sid(body.get('sourceId'))
                existing=dst.execute("SELECT id FROM "+table+" WHERE json_extract(body,'$.sourceId')=?",(source_id,)).fetchone()
                if existing:maps[table][row['id']]=existing['id'];continue
                for field,related in (('areaId','areas'),('projectId','projects'),('headingId','headings')):body[field]=ref(related,body.get(field))
                body['tagIds']=[ref('tags',tag) for tag in body.get('tagIds',[])]
                if table=='tasks':body['scheduleId']=ref('recurring_schedules',body.get('scheduleId'))
                body.pop('effectiveTagIds',None)
                if table=='recurring_schedules':
                    new=dst.execute('INSERT INTO recurring_schedules(body,next_occurrence_date) VALUES (?,?)',(json.dumps(body),body.get('nextOccurrenceDate'))).lastrowid
                else:new=dst.execute('INSERT INTO tasks(body) VALUES (?)',(json.dumps(body),)).lastrowid
                body['id']=new
                dst.execute('UPDATE '+table+' SET body=? WHERE id=?',(json.dumps(body,ensure_ascii=False),new))
                maps[table][row['id']]=new;counts[table]+=1;tick()
        if dst.execute('PRAGMA foreign_key_check').fetchall():raise ValueError('Foreign key validation failed')
        for table in ('tasks','recurring_schedules'):
            for row in dst.execute('SELECT id,body FROM '+table):
                body=json.loads(row['body'])
                if body.get('id')!=row['id']:raise ValueError('Task identity validation failed')
        dst.execute('INSERT INTO things_import_runs VALUES (?,?,?,?)',(source_sha,package_sha,datetime.datetime.now(datetime.timezone.utc).isoformat(),json.dumps(counts)))
        dst.commit()
        return dict(alreadyImported=False,inserted=counts)
    except BaseException:
        dst.rollback();raise
    finally:src.close();dst.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preview',required=True)
    parser.add_argument('--target',required=True)
    parser.add_argument('--source-sha',required=True)
    args=parser.parse_args()
    print(json.dumps(merge(args.preview,args.target,args.source_sha)))
