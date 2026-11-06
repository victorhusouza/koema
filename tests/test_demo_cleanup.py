import importlib.util,json,sqlite3,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('demo_cleanup',Path(__file__).resolve().parents[1]/'scripts/cleanup_demo_tasks.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class DemoCleanupTests(unittest.TestCase):
    def test_keeps_only_backup_tasks_and_archives_other_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'fictional.sqlite';db=sqlite3.connect(path)
            db.execute('CREATE TABLE tasks(id INTEGER PRIMARY KEY,body TEXT NOT NULL)')
            db.execute('CREATE TABLE recurring_schedules(id INTEGER PRIMARY KEY,body TEXT NOT NULL)')
            db.execute('INSERT INTO recurring_schedules VALUES (?,?)',(1,json.dumps(dict(sourceId='things:fictional-rule',rule=dict(paused=False)))))
            rows=[(1,dict(title=m.DEMO_TITLES[1])),(2,dict(title=m.DEMO_TITLES[2],sourceId='things:fictional')),(3,dict(title='User renamed this task')),(11,dict(title='Mandar promos e emissões')),(99,dict(title=m.DEMO_TITLES[1]))]
            db.executemany('INSERT INTO tasks VALUES (?,?)',[(id,json.dumps(t)) for id,t in rows]);db.commit();db.close()
            self.assertEqual(m.clean(path)['nonThingsTasksArchived'],4)
            self.assertEqual(m.clean(path,True)['nonThingsTasksArchived'],4)
            db=sqlite3.connect(path)
            self.assertEqual([r[0] for r in db.execute('SELECT id FROM tasks ORDER BY id')],[2])
            self.assertEqual(db.execute("SELECT count(*) FROM things_cleanup_archive WHERE kind='non_things_task'").fetchone()[0],4);db.close()
            self.assertEqual(m.clean(path,True)['nonThingsTasksArchived'],0)
if __name__=='__main__':unittest.main()
