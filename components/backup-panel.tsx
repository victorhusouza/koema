'use client';
import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { localDateKey } from '../lib/dates';

type BackupInfo = { createdAt: string; appVersion: string; schemaVersion: number; counts: { tasks: number; areas: number; projects: number; briefings: number; manualEvents: number } };
type Result = { info: BackupInfo; message?: string };
function date(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Belem' }).format(parsed); }
function countLine(info: BackupInfo) { const c = info.counts; const item = (count: number, singular: string, plural: string) => `${count} ${count === 1 ? singular : plural}`; return `${item(c.tasks, 'tarefa', 'tarefas')} · ${item(c.areas, 'área', 'áreas')} · ${item(c.projects, 'projeto', 'projetos')} · ${item(c.briefings, 'briefing', 'briefings')} · ${item(c.manualEvents, 'compromisso', 'compromissos')}`; }

export default function BackupPanel() {
 const input = useRef<HTMLInputElement>(null);
 const [busy, setBusy] = useState(false);
 const [fileSelected, setFileSelected] = useState(false);
 const [error, setError] = useState('');
 const [result, setResult] = useState<Result | null>(null);
 async function exportBackup() {
  if (busy) return;
  setBusy(true); setError(''); setResult(null);
  try {
   const response = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
   if (!response.ok) { const body = await response.json(); throw new Error(body.error || 'Não foi possível exportar o backup.'); }
   const raw = response.headers.get('X-Koema-Backup-Info');
   if (!raw) throw new Error('A exportação não retornou os dados de conferência.');
   const info = JSON.parse(decodeURIComponent(raw)) as BackupInfo;
   const blob = await response.blob();
   const url = URL.createObjectURL(blob); const link = document.createElement('a');
   link.href = url; link.download = `koema-backup-${localDateKey(info.createdAt)}.sqlite`; link.click(); URL.revokeObjectURL(url);
   setResult({ info, message: 'Backup exportado. Guarde o arquivo em um local protegido.' });
  } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível exportar o backup.'); }
  finally { setBusy(false); }
 }
 async function restore() {
  const file = input.current?.files?.[0];
  if (!file || busy) return;
  setBusy(true); setError(''); setResult(null);
  try {
   const form = new FormData(); form.set('backup', file);
   const response = await fetch('/api/backup', { method: 'POST', body: form, cache: 'no-store' });
   const body = await response.json();
   if (!response.ok) throw new Error(body.error || 'Não foi possível verificar o arquivo.');
   setResult({ info: body.info, message: body.message });
   if (input.current) input.current.value = '';
   setFileSelected(false);
  } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível verificar o arquivo.'); }
  finally { setBusy(false); }
 }
 return <section className="card backup-panel">
  <div className="section-top"><h2>Backup e restauração</h2></div>
  <div className="backup-content">
   <p>Exporte uma cópia consistente dos seus dados locais. O arquivo inclui tarefas e histórico, áreas, projetos, briefings e compromissos manuais.</p>
   <p>O backup não inclui a conexão do Google Agenda nem credenciais. Depois de usar uma cópia, conecte novamente o calendário se quiser consultar eventos.</p>
   <button className="primary" onClick={() => void exportBackup()} disabled={busy}><Download size={15}/>{busy ? 'Preparando…' : 'Exportar backup'}</button>
   <div className="backup-divider"/>
   <h3>Verificar uma cópia em banco separado</h3>
   <p>Selecione um arquivo exportado pelo Koema. O sistema verifica a integridade e salva a cópia em uma pasta local de restaurações. O banco ativo permanece inalterado.</p>
   <label className="backup-file">Arquivo de backup<input ref={input} type="file" accept=".sqlite,application/vnd.sqlite3,application/octet-stream" onChange={() => { setFileSelected(!!input.current?.files?.length); setError(''); setResult(null); }}/></label>
   <button className="secondary" onClick={() => void restore()} disabled={busy || !fileSelected}><Upload size={15}/>Verificar e salvar cópia separada</button>
   <p className="muted">Limite de arquivo: 64 MB. Esta verificação não troca o banco usado pelo painel.</p>
   {error && <p className="backup-message backup-error" role="alert">{error}</p>}
   {result && <div className="backup-message" role="status"><strong>{result.message || 'Cópia verificada.'}</strong><span>Backup de {date(result.info.createdAt)} · formato {result.info.schemaVersion} · versão Koema {result.info.appVersion}</span><span>{countLine(result.info)}</span></div>}
  </div>
 </section>;
}
