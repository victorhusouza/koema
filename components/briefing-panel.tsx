'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Clock3, Leaf, Pencil, Sparkles, X } from 'lucide-react';
import type { Briefing } from '../lib/briefing';
import { localDay } from '../lib/task-dates';
import styles from './briefing-panel.module.css';

const sections = ['Hoje', 'Pendências', 'Semana'] as const;
type Section = (typeof sections)[number];
type BriefContent = Pick<Briefing, Section>;
type HistoryItem = Pick<Briefing, 'date' | 'updatedAt'>;
const emptyContent: BriefContent = { Hoje: '', Pendências: '', Semana: '' };

function dateName(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}
function dateStamp(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}
function points(text: string) {
  return text.split(/\n+/).map(line => line.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
}
function renderPoints(text: string) {
  const lines = points(text);
  return lines.length ? <ul className={styles.points}>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul> : <p className={styles.emptySection}>Nenhum tópico neste dia.</p>;
}

export default function BriefingPanel({ mode }: { mode: 'today' | 'history' | 'hidden' }) {
  const [today, setToday] = useState(localDay());
  const [date, setDate] = useState(localDay());
  const [content, setContent] = useState<BriefContent>(emptyContent);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [paste, setPaste] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  const dateRef = useRef(date);
  const versionRef = useRef(0);
  const dirtyRef = useRef(false);
  const requestRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    const tick = () => setToday(localDay());
    const interval = setInterval(tick, 30000);
    window.addEventListener('focus', tick);
    return () => { clearInterval(interval); window.removeEventListener('focus', tick); };
  }, []);
  useEffect(() => {
    if (!editorOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') void closeEditor(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorOpen]);
  useEffect(() => {
    if (mode === 'today' && !editorOpen && date !== today) void selectDate(today);
  }, [date, today, mode, editorOpen]);

  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { dateRef.current = date; }, [date]);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch('/api/briefings', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Não foi possível carregar o histórico.');
      setHistory(Array.isArray(body) ? body : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar o histórico.');
      setStatus('error');
    }
  }, []);

  const loadDate = useCallback(async (nextDate: string) => {
    setLoading(true); setError(''); setStatus('idle');
    try {
      const response = await fetch(`/api/briefings/${nextDate}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Não foi possível carregar o briefing.');
      const next = body && body.date ? { Hoje: body.Hoje || '', Pendências: body.Pendências || '', Semana: body.Semana || '' } : emptyContent;
      dateRef.current = nextDate; contentRef.current = next; dirtyRef.current = false;
      setDate(nextDate); setContent(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar o briefing.'); setStatus('error');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadDate(localDay()); void loadHistory(); }, [loadDate, loadHistory]);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (requestRef.current) {
      const ok = await requestRef.current;
      if (!ok) return false;
      if (!dirtyRef.current) return true;
    }
    if (!dirtyRef.current) return true;
    const savedVersion = versionRef.current;
    const savedDate = dateRef.current;
    const snapshot = contentRef.current;
    dirtyRef.current = false; setStatus('saving'); setError('');
    const request = (async () => {
      try {
        const response = await fetch(`/api/briefings/${savedDate}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Não foi possível salvar o briefing.');
        setStatus('saved');
        void loadHistory();
        return true;
      } catch (cause) {
        dirtyRef.current = true;
        setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o briefing.'); setStatus('error');
        return false;
      } finally { requestRef.current = null; }
    })();
    requestRef.current = request;
    const ok = await request;
    if (ok && versionRef.current !== savedVersion) return flush();
    return ok;
  }, [loadHistory, status]);

  const scheduleSave = useCallback((next: BriefContent) => {
    contentRef.current = next; setContent(next); dirtyRef.current = true; versionRef.current += 1;
    setStatus('idle'); setError('');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 650);
  }, [flush]);

  async function selectDate(nextDate: string) {
    if (nextDate === dateRef.current || loading) return;
    if (!(await flush())) return;
    await loadDate(nextDate);
  }
  async function closeEditor() {
    if (!(await flush())) return;
    setEditorOpen(false); setPaste('');
  }

  function organizePaste() {
    const chunks: Record<Section, string[]> = { Hoje: [], Pendências: [], Semana: [] };
    let current: Section = 'Hoje';
    for (const line of paste.split(/\r?\n/)) {
      const clean = line.replace(/^\s*#+\s*/, '').replace(/[:*]+\s*$/, '').trim().toLocaleLowerCase('pt-BR');
      const match = sections.find(section => section.toLocaleLowerCase('pt-BR') === clean);
      if (match) current = match;
      else chunks[current].push(line);
    }
    scheduleSave({ Hoje: chunks.Hoje.join('\n').trim(), Pendências: chunks.Pendências.join('\n').trim(), Semana: chunks.Semana.join('\n').trim() });
    setPaste('');
  }

  if (mode === 'hidden') return null;
  if (mode === 'today') return <section className="card briefing">
    <div className="section-top"><div className="section-label"><Sparkles size={17}/><span>SEU BRIEFING</span></div><button className="text-button" onClick={() => setEditorOpen(true)}><Pencil size={14}/> {content.Hoje || content.Pendências || content.Semana ? 'Editar briefing' : 'Adicionar briefing de hoje'}</button></div>
    <h2>Bom dia, Victor!</h2><p className="brief-date">BRIEFING DE {dateStamp(today).toLocaleUpperCase('pt-BR')}</p>
    <div className="brief-notebook">{sections.map(section => <div key={section}><h3>{section}</h3>{loading ? <p className={styles.emptySection}>Carregando briefing…</p> : renderPoints(content[section])}</div>)}</div>
    <div className="brief-footer"><span className="tiny-dot"/> {status === 'saving' ? 'Salvando…' : status === 'saved' ? 'Salvo' : status === 'error' ? 'Erro ao salvar' : content.Hoje || content.Pendências || content.Semana ? 'Briefing do dia' : 'Nenhum briefing enviado'} <span className="dot-separator">·</span> {dateName(today)} <Leaf size={15}/></div>
    {editorOpen && <div className="modal-backdrop" onClick={() => void closeEditor()}><section className="modal" role="dialog" aria-modal="true" aria-label="Editar briefing" onClick={event => event.stopPropagation()}><div className="section-top"><h2>Seu briefing · {dateStamp(date)}</h2><button className="icon-button" aria-label="Fechar janela" onClick={() => void closeEditor()}><X size={19}/></button></div>
      <label>Cole seu briefing<textarea autoFocus placeholder={'Hoje\nSeu resumo do dia…\n\nPendências\nO que ficou em aberto…\n\nSemana\nO que vem pela frente…'} value={paste} onChange={event => setPaste(event.target.value)}/></label><button className="secondary" disabled={!paste.trim()} onClick={organizePaste}>Organizar nas seções</button>
      {sections.map(section => <label key={section}>{section}<textarea className="short-textarea" value={content[section]} onChange={event => scheduleSave({ ...contentRef.current, [section]: event.target.value })}/></label>)}
      {status === 'saving' && <p className={styles.status}>Salvando…</p>}{status === 'saved' && <p className={styles.status}>Salvo</p>}{status === 'error' && <p className="save-error" role="alert">{error} O rascunho continua disponível. Corrija a conexão e tente fechar novamente.</p>}
      <p className="muted">Uma linha ou parágrafo por tópico. O texto fica no briefing e não cria tarefas.</p><button className="primary full" onClick={() => void closeEditor()}>Concluir edição</button>
    </section></div>}
  </section>;

  return <section className="card history"><div className="section-top"><h2><BookOpen size={19}/> Histórico de briefings</h2><label className={styles.datePicker}>Abrir data<input type="date" value={date} max={today} onInput={event => void selectDate(event.currentTarget.value)}/></label></div>
    {status === 'error' && error && <p className="save-error" role="alert">{error}</p>}
    {loading ? <p className={styles.status}>Carregando briefing…</p> : <><h3>{dateName(date)}</h3><div className="brief-notebook">{sections.map(section => <div key={section}><h3>{section}</h3>{renderPoints(content[section])}</div>)}</div><p className="muted">{content.Hoje || content.Pendências || content.Semana ? `Briefing de ${dateStamp(date)}.` : 'Nenhum briefing salvo nesta data.'}</p><button className="text-button" onClick={() => setEditorOpen(true)}><Pencil size={14}/> Editar este dia</button></>}
    <div className={styles.historyList}><h3><Clock3 size={15}/> Dias salvos</h3>{history.length ? history.map(item => <button key={item.date} onClick={() => void selectDate(item.date)}>{dateName(item.date)} <span>{item.updatedAt ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Belem' }).format(new Date(item.updatedAt)) : 'Importado'}</span></button>) : <p className="muted">Ainda não há briefings salvos no histórico.</p>}</div>
    {editorOpen && <div className="modal-backdrop" onClick={() => void closeEditor()}><section className="modal" role="dialog" aria-modal="true" aria-label="Editar briefing" onClick={event => event.stopPropagation()}><div className="section-top"><h2>Editar · {dateStamp(date)}</h2><button className="icon-button" aria-label="Fechar janela" onClick={() => void closeEditor()}><X size={19}/></button></div>
      <label>Cole seu briefing<textarea autoFocus value={paste} onChange={event => setPaste(event.target.value)} placeholder={'Hoje\nSeu resumo…\n\nPendências\nO que ficou em aberto…\n\nSemana\nO que vem pela frente…'}/></label><button className="secondary" disabled={!paste.trim()} onClick={organizePaste}>Organizar nas seções</button>{sections.map(section => <label key={section}>{section}<textarea className="short-textarea" value={content[section]} onChange={event => scheduleSave({ ...contentRef.current, [section]: event.target.value })}/></label>)}
      {status === 'saving' && <p className={styles.status}>Salvando…</p>}{status === 'saved' && <p className={styles.status}>Salvo</p>}{status === 'error' && <p className="save-error" role="alert">{error} O rascunho continua disponível.</p>}<button className="primary full" onClick={() => void closeEditor()}>Concluir edição</button>
    </section></div>}
  </section>;
}
