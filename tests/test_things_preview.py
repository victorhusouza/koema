"""Fictional codec fixtures only; never read the user's Things export."""
import importlib.util
from pathlib import Path
import unittest
import tempfile
import sqlite3
import json
import hashlib

spec = importlib.util.spec_from_file_location('things_preview', Path(__file__).resolve().parents[1]/'scripts/things_preview.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class ThingsPreviewTests(unittest.TestCase):
    def test_civil_dates_and_sentinels(self):
        self.assertEqual(preview.civil((2024<<16)|(2<<12)|(29<<7)), '2024-02-29')
        self.assertIsNone(preview.civil((4001<<16)|(1<<12)|(1<<7)))
        with self.assertRaises(ValueError): preview.civil((2023<<16)|(2<<12)|(29<<7))
        with self.assertRaises(ValueError): preview.civil(123)

    def test_reminders_include_midnight_and_validate_fields(self):
        self.assertEqual(preview.clock((12<<26)|(34<<20)), '12:34')
        self.assertEqual(preview.clock(0), '00:00')
        self.assertIsNone(preview.clock(None))
        with self.assertRaises(ValueError): preview.clock(24<<26)
        with self.assertRaises(ValueError): preview.clock((10<<26)|(60<<20))

    def test_dated_someday_code_is_not_an_undated_someday_task(self):
        self.assertEqual(preview.placement(2,0,'2026-11-03','2026-10-29'),('Planejada','2026-11-03'))
        self.assertEqual(preview.placement(2,0,'2026-10-28','2026-10-29'),('Hoje','2026-10-29'))
        self.assertEqual(preview.placement(2,0,None,'2026-10-29'),('Algum dia',None))
        self.assertEqual(preview.placement(1,1,None,'2026-10-29'),('Hoje','2026-10-29'))

    def test_unknown_rules_remain_unconverted(self):
        base=dict(rrv=4,tp=0,rc=0,ts=0,ia=1735689600,ed=64092211200,fa=1,fu=256,of=[dict(wd=1)])
        converted=preview.rule(base,True)
        self.assertEqual(converted['weekdays'],[1])
        self.assertTrue(converted['paused'])
        self.assertIsNone(converted['endDate'])
        with self.assertRaises(ValueError): preview.rule(dict(base,fu=8,of=[dict(wd=6,wdo=1)]),False)
        with self.assertRaises(ValueError): preview.rule(dict(base,tp=99),False)
        special=dict(base,fu=8,of=[dict(wd=6,wdo=1)])
        self.assertEqual(preview.rule(special,False,True)['ordinalWeekdays'],[dict(weekday=6,ordinal=1)])
        with self.assertRaises(ValueError): preview.rule(dict(base,fu=8,of=[dict(wd=0,wdo=4)]),False,True)

    def test_capitalization_preserves_brands_and_numbers(self):
        for name in ['iPhone','eBay','123 tarefa']: self.assertEqual(preview.capital(name),name)
        self.assertEqual(preview.capital('mandar promos'),'Mandar promos')



    def test_fictional_end_to_end_preserves_history_and_excludes_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.sqlite'
            db=sqlite3.connect(source)
            fields='uuid title notes type status trashed creationDate userModificationDate stopDate start startBucket startDate deadline reminderTime index area project heading rt1_repeatingTemplate rt1_recurrenceRule rt1_instanceCreationPaused rt1_nextInstanceStartDate'.split()
            numeric={'type','status','trashed','start','startBucket','startDate','deadline','reminderTime','index','rt1_instanceCreationPaused','rt1_nextInstanceStartDate'}
            db.execute('CREATE TABLE TMTask ('+','.join('"'+f+'" '+('INTEGER' if f in numeric else 'BLOB' if f=='rt1_recurrenceRule' else 'REAL' if f.endswith('Date') else 'TEXT') for f in fields)+')')
            db.executescript("CREATE TABLE TMArea(uuid,title,\"index\"); CREATE TABLE TMTag(uuid,title,parent,shortcut,\"index\"); CREATE TABLE TMChecklistItem(task,title,status,\"index\",uuid); CREATE TABLE TMTaskTag(tasks,tags); CREATE TABLE TMSettings(secret);")
            db.execute('INSERT INTO TMSettings VALUES (?)',('Fictional-secret-do-not-export',))
            db.execute('INSERT INTO TMTask(uuid,title,type,status,trashed,start,startBucket,stopDate,creationDate,userModificationDate) VALUES (?,?,?,?,?,?,?,?,?,?)',('fixture-done','completed fixture',0,3,0,1,0,1700000000,1699000000,1700000000))
            db.execute('INSERT INTO TMChecklistItem VALUES (?,?,?,?,?)',('fixture-done','finished step',3,0,'fixture-step'))
            db.commit();db.close()
            before=hashlib.sha256(source.read_bytes()).hexdigest()
            output=Path(directory)/'preview'
            report=preview.preview(source,output,'2026-10-29')
            self.assertEqual(report['counts']['tasks'],1)
            self.assertEqual(before,hashlib.sha256(source.read_bytes()).hexdigest())
            target=sqlite3.connect(output/'koema-preview.sqlite')
            task=json.loads(target.execute('SELECT body FROM tasks').fetchone()[0]);target.close()
            self.assertTrue(task['done'])
            self.assertEqual(task['completed'],'2023-11-14T22:13:20Z')
            self.assertTrue(task['checklist'][0]['done'])
            self.assertEqual(task['sourceId'],'things:fixture-done')
            self.assertNotIn(b'Fictional-secret-do-not-export',(output/'koema-preview.sqlite').read_bytes())
            self.assertFalse(report['productionImportReady'])
            with self.assertRaises(FileExistsError):preview.preview(source,output,'2026-10-29')


if __name__ == '__main__': unittest.main()
