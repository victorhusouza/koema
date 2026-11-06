"""Keep only Things-source tasks; archive every other task for recovery."""
import argparse,datetime,json,sqlite3
from pathlib import Path
DEMO_TITLES={1:'Preparar a proposta do novo projeto',2:'Revisar os materiais para a reunião',3:'Reservar um tempo para leitura',4:'Organizar as referências do projeto',5:'Planejar as refeições da semana',6:'Revisar o planejamento semanal',7:'Pesquisar destinos para as férias',8:'Conhecer uma nova trilha',9:'Anotar ideias para o próximo mês',10:'Organizar a mesa de trabalho'}

def clean(path,apply=False):
    path=Path(path).resolve(strict=True)
    db=sqlite3.connect(path.as_uri()+('?mode=rw' if apply else '?mode=ro'),uri=True)
    try:
        if apply:db.execute('BEGIN IMMEDIATE')
        selected=[]
        for id,body in db.execute('SELECT id,body FROM tasks'):
            task=json.loads(body)
            if not isinstance(task.get('sourceId'),str) or not task['sourceId'].startswith('things:'):
                selected.append((id,body))
        paused=0
        if apply:
            db.execute('CREATE TABLE IF NOT EXISTS things_cleanup_archive(kind TEXT NOT NULL,row_id INTEGER NOT NULL,body TEXT NOT NULL,archived_at TEXT NOT NULL,PRIMARY KEY(kind,row_id))')
            now=datetime.datetime.now(datetime.timezone.utc).isoformat()
            for id,body in selected:
                db.execute('INSERT OR IGNORE INTO things_cleanup_archive VALUES (?,?,?,?)',('non_things_task',id,body,now))
                db.execute('DELETE FROM tasks WHERE id=?',(id,))
            for schedule_id,body in db.execute('SELECT id,body FROM recurring_schedules').fetchall():
                schedule=json.loads(body)
                if str(schedule.get('sourceId','')).startswith('things:') and not schedule['rule'].get('paused'):
                    db.execute('INSERT OR IGNORE INTO things_cleanup_archive VALUES (?,?,?,?)',('schedule_before_pause',schedule_id,body,now))
                    schedule['rule']['paused']=True
                    db.execute('UPDATE recurring_schedules SET body=? WHERE id=?',(json.dumps(schedule,ensure_ascii=False),schedule_id))
                    paused+=1
            if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Integrity verification failed')
            db.commit()
        return dict(nonThingsTasksArchived=len(selected),importedTasksRemoved=0,importedSchedulesTemporarilyPaused=paused)
    except BaseException:
        if apply:db.rollback()
        raise
    finally:db.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',required=True)
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    print(json.dumps(clean(args.database,args.apply)))
