"""Transactional import tests use invented task content and isolated databases."""
import importlib.util,json,sqlite3,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('merge',ROOT/'scripts/import_things_preview.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class MergeTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.root=Path(self.directory.name)
        self.source=self.root/'source.sqlite';self.target=self.root/'target.sqlite'
        for path in (self.source,self.target):
            subprocess.run(['node','--experimental-strip-types','--input-type=module','-e','import {openTaskStore} from "./lib/task-store.ts";openTaskStore(process.argv[1]).close();',str(path)],cwd=ROOT,check=True,capture_output=True)
        source=sqlite3.connect(self.source)
        for table in ('tasks','recurring_schedules','headings','projects','areas','tags'):source.execute('DELETE FROM '+table)
        source.execute("INSERT INTO areas(id,name,source_id) VALUES (1,'Fixture Area','things:fixture-area')")
        source.execute("INSERT INTO tags(id,name,source_id) VALUES (1,'Fixture Tag','things:fixture-tag')")
        source.execute("INSERT INTO projects(id,area_id,name,tag_ids,source_id) VALUES (1,1,'Fixture Project','[1]','things:fixture-project')")
        source.execute("INSERT INTO headings(id,project_id,title,source_id) VALUES (1,1,'Fixture Heading','things:fixture-heading')")
        schedule=dict(id=1,sourceId='things:fixture-schedule',title='Fixture Schedule',areaId=1,projectId=1,headingId=1,tagIds=[1],nextOccurrenceDate='2026-11-01')
        source.execute('INSERT INTO recurring_schedules VALUES (?,?,?)',(1,json.dumps(schedule),'2026-11-01'))
        task=dict(id=1,sourceId='things:fixture-task',title='Fixture task',done=True,completed='2026-10-01T10:00:00Z',areaId=1,projectId=1,headingId=1,tagIds=[1],scheduleId=1,scheduledFor='2026-10-01',checklist=[dict(text='Fixture step',done=True)])
        source.execute('INSERT INTO tasks VALUES (?,?)',(1,json.dumps(task)));source.commit();source.close()
        target=sqlite3.connect(self.target);target.execute('CREATE TABLE private_auth_fixture(secret TEXT)');target.execute("INSERT INTO private_auth_fixture VALUES ('Fictional session credential')");target.commit();target.close()
    def tearDown(self):self.directory.cleanup()
    def snapshot(self):
        db=sqlite3.connect(self.target);result='\n'.join(db.iterdump());db.close();return result
    def test_merge_remaps_relationships_and_preserves_existing_data(self):
        db=sqlite3.connect(self.target);original=db.execute('SELECT id,body FROM tasks').fetchall();db.close()
        result=module.merge(self.source,self.target,'a'*64)
        self.assertEqual(result['inserted']['tasks'],1)
        db=sqlite3.connect(self.target)
        for row in original:self.assertEqual(db.execute('SELECT id,body FROM tasks WHERE id=?',(row[0],)).fetchone(),row)
        task_id,body=db.execute("SELECT id,body FROM tasks WHERE json_extract(body,'$.sourceId')='things:fixture-task'").fetchone();task=json.loads(body)
        self.assertEqual(task['id'],task_id);self.assertNotEqual(task_id,1)
        area=db.execute("SELECT id FROM areas WHERE source_id='things:fixture-area'").fetchone()[0]
        self.assertEqual(task['areaId'],area)
        self.assertEqual(task['completed'],'2026-10-01T10:00:00Z')
        self.assertEqual(db.execute('SELECT secret FROM private_auth_fixture').fetchone()[0],'Fictional session credential')
        db.execute('DELETE FROM tasks WHERE id=?',(task_id,));db.commit();db.close()
        self.assertTrue(module.merge(self.source,self.target,'a'*64)['alreadyImported'])
        db=sqlite3.connect(self.target);self.assertIsNone(db.execute('SELECT 1 FROM tasks WHERE id=?',(task_id,)).fetchone());db.close()
    def test_failure_rolls_back_all_changes(self):
        before=self.snapshot()
        with self.assertRaises(RuntimeError):module.merge(self.source,self.target,'a'*64,fail_after=6)
        self.assertEqual(before,self.snapshot())
    def test_conflict_rolls_back_without_merging_projects(self):
        db=sqlite3.connect(self.target)
        area=db.execute("INSERT INTO areas(name) VALUES ('Fixture Area')").lastrowid
        db.execute("INSERT INTO projects(area_id,name) VALUES (?,'Fixture Project')",(area,));db.commit();db.close()
        before=self.snapshot()
        with self.assertRaisesRegex(ValueError,'project name conflicts'):module.merge(self.source,self.target,'a'*64)
        self.assertEqual(before,self.snapshot())
    def test_changed_package_under_same_source_fingerprint_is_refused(self):
        module.merge(self.source,self.target,'a'*64)
        db=sqlite3.connect(self.source);db.execute("UPDATE areas SET name='Changed fixture'");db.commit();db.close()
        before=self.snapshot()
        with self.assertRaisesRegex(ValueError,'different reviewed package'):module.merge(self.source,self.target,'a'*64)
        self.assertEqual(before,self.snapshot())

if __name__=='__main__':unittest.main()
