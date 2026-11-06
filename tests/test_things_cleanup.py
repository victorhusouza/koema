import datetime as dt,importlib.util,unittest,tempfile,sqlite3,json,subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location('cleanup',Path(__file__).resolve().parents[1]/'scripts/cleanup_things_duplicates.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class CleanupTests(unittest.TestCase):
    def fixture(self,day):
        return dict(title='Fictional daily task',notes='',areaId=None,projectId=None,headingId=None,tagIds=[],checklist=[],deadline=None,reminderAt=None,done=False,plannedDate=day,scheduledFor=day,scheduleId=1,createdAt='2026-10-29T10:00:00Z',updatedAt='2026-10-29T10:00:00Z')
    def test_preserves_original_future_history_and_edited_tasks(self):
        schedule=dict(title='Fictional daily task',notes='',areaId=None,projectId=None,headingId=None,tagIds=[],checklist=[],deadlineOffset=None,reminderTime=None)
        original=dict(self.fixture('2026-10-28'),sourceId='things:fixture')
        rows=[(1,original),(2,self.fixture('2026-10-29')),(3,self.fixture('2026-10-30')),(4,self.fixture('2026-11-01')),(5,dict(self.fixture('2026-10-29'),done=True)),(6,dict(self.fixture('2026-10-30'),notes='User edit'))]
        self.assertEqual(m.candidates(rows,{1:schedule},'2026-10-31'),[2,3])
    def test_keeps_most_recent_generated_occurrence(self):
        schedule=dict(title='Fictional daily task',notes='',areaId=None,projectId=None,headingId=None,tagIds=[],checklist=[],deadlineOffset=None,reminderTime=None)
        self.assertEqual(m.candidates([(1,self.fixture('2026-10-29')),(2,self.fixture('2026-10-31'))],{1:schedule},'2026-10-31'),[1])
    def test_completed_checklist_or_reordered_task_is_not_removed(self):
        schedule=dict(title='Fictional daily task',notes='',areaId=None,projectId=None,headingId=None,tagIds=[],checklist=[],deadlineOffset=None,reminderTime=None)
        for change in [dict(position=0),dict(checklist=[dict(text='User step',done=True)]),dict(updatedAt='2026-10-29T11:00:00Z')]:self.assertFalse(m.unchanged_generated(dict(self.fixture('2026-10-29'),**change),schedule))

    def test_transaction_archives_duplicates_and_preserves_demo_project_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'fixture.sqlite'
            root=Path(__file__).resolve().parents[1]
            subprocess.run(['node','--experimental-strip-types','--input-type=module','-e','import {openTaskStore} from "./lib/task-store.ts";openTaskStore(process.argv[1]).close();',str(path)],cwd=root,check=True,capture_output=True)
            db=sqlite3.connect(path)
            before=db.execute('SELECT count(*) FROM tasks').fetchone()[0]
            demo=db.execute("SELECT p.id FROM projects p JOIN areas a ON a.id=p.area_id WHERE a.name='Trabalho' AND p.name='Proposta comercial'").fetchone()[0]
            retained=[r[0] for r in db.execute("SELECT id FROM tasks WHERE json_extract(body,'$.projectId')=?",(demo,))]
            schedule=dict(id=1,sourceId='things:fixture-schedule',rule=dict(paused=False),title='Fictional daily task',notes='',areaId=None,projectId=None,headingId=None,tagIds=[],checklist=[],deadlineOffset=None,reminderTime=None)
            db.execute('INSERT INTO recurring_schedules VALUES (?,?,?)',(1,json.dumps(schedule),'2026-11-01'))
            for day in ['2026-10-29','2026-10-31']:
                db.execute('INSERT INTO tasks(body) VALUES (?)',(json.dumps(self.fixture(day)),))
            db.commit();db.close()
            self.assertEqual(m.clean(path,'2026-10-31')['generatedOccurrencesToQuarantine'],1)
            result=m.clean(path,'2026-10-31',True)
            self.assertEqual(result['demoProjectsToRemove'],1)
            db=sqlite3.connect(path)
            self.assertEqual(db.execute('SELECT count(*) FROM tasks').fetchone()[0],before+1)
            self.assertEqual(db.execute("SELECT count(*) FROM things_cleanup_archive WHERE kind='generated_task'").fetchone()[0],1)
            self.assertIsNone(db.execute('SELECT id FROM projects WHERE id=?',(demo,)).fetchone())
            for id in retained:self.assertIsNone(json.loads(db.execute('SELECT body FROM tasks WHERE id=?',(id,)).fetchone()[0])['projectId'])
            self.assertTrue(json.loads(db.execute('SELECT body FROM recurring_schedules WHERE id=1').fetchone()[0])['rule']['paused'])
            db.close()
            again=m.clean(path,'2026-10-31',True)
            self.assertEqual(again['generatedOccurrencesToQuarantine'],0)
            self.assertEqual(again['importedSchedulesToPause'],0)
            self.assertEqual(again['demoProjectsToRemove'],0)

if __name__=='__main__':unittest.main()
