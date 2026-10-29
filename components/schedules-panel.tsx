'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { describeRecurrence, type RecurrenceRule } from '../lib/recurrence';
import type { Area, Project, RecurringSchedule, Tag } from '../lib/task-store';

type SchedulesPanelProps = { areas: Area[]; projects: Project[]; tags: Tag[]; onChanged?: () => void };
type ScheduleDraft = Omit<RecurringSchedule, 'id' | 'nextOccurrenceDate' | 'sourceId'>;
const blank = (date: string): ScheduleDraft => ({
 title: '', notes: '', checklist: [], areaId: null, projectId: null, headingId: null, tagIds: [],
 deadlineOffset: null, reminderTime: null,
 rule: { mode: 'calendar', unit: 'week', interval: 1, anchorDate: date, weekdays: [1, 2, 3, 4, 5] },
});
const week = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const month = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

async function api(path: string, method = 'GET', body?: unknown) {
 const response = await fetch(path, { method, cache: 'no-store', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
 const value = await response.json();
 if (!response.ok) throw new Error(value.error || 'Não foi possível salvar a repetição.');
 return value;
}

export default function SchedulesPanel({ areas, projects, tags, onChanged }: SchedulesPanelProps) {
 const [items, setItems] = useState<RecurringSchedule[]>([]);
 const [draft, setDraft] = useState<ScheduleDraft | null>(null);
 const [editingId, setEditingId] = useState<number | null>(null);
 const [headings, setHeadings] = useState<{id:number;projectId:number;title:string;position:number}[]>([]);
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState('');
 const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Belem' });
 async function load() { try { setItems(await api('/api/schedules')); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível carregar as repetições.'); } }
 useEffect(() => { void load(); }, []);
 useEffect(() => { if (!draft?.projectId) { setHeadings([]); return; } void api(`/api/headings?projectId=${draft.projectId}`).then(setHeadings).catch(() => setHeadings([])); }, [draft?.projectId]);
 function updateRule(patch: Partial<RecurrenceRule>) { setDraft(current => {
  if (!current) return current;
  const rule:RecurrenceRule={...current.rule,...patch};
  if(rule.mode==='after-completion'){delete rule.weekdays;delete rule.monthDays;delete rule.ordinalWeekdays;delete rule.months;}
  else {
   if(rule.unit!=='day'&&rule.unit!=='week')delete rule.weekdays;
   if(rule.unit!=='month'&&rule.unit!=='year'){delete rule.monthDays;delete rule.ordinalWeekdays;delete rule.months;}
   if(rule.unit==='month')delete rule.months;
  }
  return {...current,rule};
 }); }
 function edit(item: RecurringSchedule) { const { id, nextOccurrenceDate, sourceId, ...value } = item; setEditingId(id); setDraft(structuredClone(value)); setError(''); }
 async function save(event: React.FormEvent) {
  event.preventDefault(); if (!draft || saving) return;
  setSaving(true); setError('');
  try { const saved = await api(editingId === null ? '/api/schedules' : `/api/schedules/${editingId}`, editingId === null ? 'POST' : 'PATCH', draft); setItems(current => editingId === null ? [...current, saved] : current.map(item => item.id === editingId ? saved : item)); setDraft(null); setEditingId(null); onChanged?.(); }
  catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar a repetição.'); }
  finally { setSaving(false); }
 }
 async function toggle(item: RecurringSchedule) { try { const saved = await api(`/api/schedules/${item.id}`, 'PATCH', { rule: { ...item.rule, paused: !item.rule.paused } }); setItems(current => current.map(value => value.id === item.id ? saved : value)); } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível atualizar a repetição.'); } }
 async function remove(item: RecurringSchedule) { if (!window.confirm(`Excluir a repetição “${item.title}”? Tarefas já criadas serão preservadas.`)) return; try { await api(`/api/schedules/${item.id}`, 'DELETE'); setItems(current => current.filter(value => value.id !== item.id)); onChanged?.(); } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível excluir a repetição.'); } }
 const eligibleProjects = projects.filter(project => draft?.areaId === null || project.areaId === draft?.areaId);
 return <section className="card list-view schedules-panel">
  <div className="section-top"><h2><CalendarClock size={18}/> Repetições</h2><button className="text-button" onClick={() => { setEditingId(null); setDraft(blank(today)); setError(''); }}><Plus size={16}/> Nova repetição</button></div>
  <p className="panel-intro">Modelos que criam tarefas recorrentes. As alterações aqui afetam as próximas ocorrências.</p>
  {error && <p className="save-error" role="alert">{error}</p>}
  {items.map(item => <article className="schedule-template" key={item.id}><div className="schedule-template-copy"><strong>{item.title}</strong><small>{describeRecurrence(item.rule)}{item.rule.paused ? ' · Pausada' : ''}{item.nextOccurrenceDate ? ` · Próxima: ${item.nextOccurrenceDate}` : ' · Sem próximas ocorrências'}</small></div><button className="icon-button" aria-label={item.rule.paused ? 'Retomar repetição' : 'Pausar repetição'} title={item.rule.paused ? 'Retomar' : 'Pausar'} onClick={() => void toggle(item)}>{item.rule.paused ? <Play size={16}/> : <Pause size={16}/>}</button><button className="text-button" onClick={() => edit(item)}>Editar</button><button className="icon-button" aria-label="Excluir repetição" onClick={() => void remove(item)}><Trash2 size={15}/></button></article>)}
  {!items.length && <p className="empty">Ainda não há repetições salvas.</p>}
  {draft && <form className="schedule-editor" onSubmit={save}>
   <div className="section-top"><h2>{editingId === null ? 'Nova repetição' : 'Editar repetição'}</h2><button type="button" className="text-button" onClick={() => { setDraft(null); setEditingId(null); }}>Fechar</button></div>
   <label>Título<input autoFocus required maxLength={240} value={draft.title} onChange={e => setDraft({...draft,title:e.target.value})}/></label>
   <label>Notas<textarea className="short-textarea" value={draft.notes} onChange={e => setDraft({...draft,notes:e.target.value})}/></label>
   <label>Lista de passos<textarea className="short-textarea" value={draft.checklist.map(item=>item.text).join('\n')} placeholder="Um passo por linha" onChange={e=>setDraft({...draft,checklist:e.target.value.split('\n').map(text=>text.trim()).filter(Boolean).map(text=>({text,done:false}))})}/></label>
   <div className="date-fields"><label>Área<select value={draft.areaId ?? ''} onChange={e => setDraft({...draft,areaId:e.target.value?Number(e.target.value):null,projectId:null,headingId:null})}><option value="">Sem área</option>{areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label><label>Projeto<select value={draft.projectId ?? ''} onChange={e => setDraft({...draft,projectId:e.target.value?Number(e.target.value):null,headingId:null})}><option value="">Sem projeto</option>{eligibleProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
   {draft.projectId && <label>Seção do projeto<select value={draft.headingId ?? ''} onChange={e => setDraft({...draft,headingId:e.target.value?Number(e.target.value):null})}><option value="">Sem seção</option>{headings.map(heading => <option key={heading.id} value={heading.id}>{heading.title || 'Sem título'}</option>)}</select></label>}
   {!!tags.length && <fieldset className="tag-picker"><legend>Etiquetas</legend><div>{tags.map(tag => <label key={tag.id}><input type="checkbox" checked={draft.tagIds.includes(tag.id)} onChange={e => setDraft({...draft,tagIds:e.target.checked?[...draft.tagIds,tag.id]:draft.tagIds.filter(id=>id!==tag.id)})}/>{tag.name}</label>)}</div></fieldset>}
   <div className="date-fields"><label>Unidade<select value={draft.rule.unit} onChange={e=>updateRule({unit:e.target.value as RecurrenceRule['unit']})}><option value="day">Dias</option><option value="week">Semanas</option><option value="month">Meses</option><option value="year">Anos</option></select></label><label>Intervalo<input type="number" min={1} max={1000} value={draft.rule.interval} onChange={e=>updateRule({interval:Number(e.target.value)})}/></label></div>
   <div className="date-fields"><label>Modo<select value={draft.rule.mode} onChange={e=>updateRule({mode:e.target.value as RecurrenceRule['mode']})}><option value="calendar">Em datas fixas</option><option value="after-completion">Após concluir</option></select></label><label>Começa em<input type="date" value={draft.rule.anchorDate} onChange={e=>updateRule({anchorDate:e.target.value})}/></label></div>
   {draft.rule.mode==='calendar' && (draft.rule.unit === 'week'||draft.rule.unit==='day') && <fieldset className="selector-field"><legend>Dias da semana</legend>{week.map((day,index)=><label key={day}><input type="checkbox" checked={draft.rule.weekdays?.includes(index) ?? false} onChange={e=>updateRule({weekdays:e.target.checked?[...new Set([...(draft.rule.weekdays??[]),index])].sort():draft.rule.weekdays?.filter(value=>value!==index)})}/>{day}</label>)}</fieldset>}
   {(draft.rule.unit === 'month' || draft.rule.unit === 'year') && <><fieldset className="selector-field"><legend>Dias do mês</legend>{Array.from({length:31},(_,i)=>i+1).map(day=><label key={day}><input type="checkbox" checked={draft.rule.monthDays?.includes(day)??false} onChange={e=>updateRule({monthDays:e.target.checked?[...new Set([...(draft.rule.monthDays??[]),day])].sort((a,b)=>a-b):draft.rule.monthDays?.filter(value=>value!==day)})}/>{day}</label>)}<label><input type="checkbox" checked={draft.rule.monthDays?.includes(-1)??false} onChange={e=>updateRule({monthDays:e.target.checked?[...(draft.rule.monthDays??[]),-1]:draft.rule.monthDays?.filter(value=>value!==-1)})}/>Último dia</label></fieldset><fieldset className="selector-field"><legend>Meses</legend>{month.map((name,index)=><label key={name}><input type="checkbox" checked={draft.rule.months?.includes(index+1)??false} onChange={e=>updateRule({months:e.target.checked?[...new Set([...(draft.rule.months??[]),index+1])].sort((a,b)=>a-b):draft.rule.months?.filter(value=>value!==index+1)})}/>{name}</label>)}</fieldset><fieldset className="ordinal-picker"><legend>Dia da semana no mês</legend>{(draft.rule.ordinalWeekdays??[]).map((selector,index)=><div key={`${selector.weekday}:${selector.ordinal}:${index}`}><select aria-label="Semana do mês" value={selector.ordinal} onChange={e=>updateRule({ordinalWeekdays:(draft.rule.ordinalWeekdays??[]).map((value,i)=>i===index?{...value,ordinal:Number(e.target.value)}:value)})}><option value="1">Primeira</option><option value="2">Segunda</option><option value="3">Terceira</option><option value="4">Quarta</option><option value="5">Quinta</option><option value="-1">Última</option></select><select aria-label="Dia da semana" value={selector.weekday} onChange={e=>updateRule({ordinalWeekdays:(draft.rule.ordinalWeekdays??[]).map((value,i)=>i===index?{...value,weekday:Number(e.target.value)}:value)})}>{week.map((day,weekday)=><option key={day} value={weekday}>{day}</option>)}</select><button type="button" className="text-button" onClick={()=>updateRule({ordinalWeekdays:(draft.rule.ordinalWeekdays??[]).filter((_,i)=>i!==index)})}>Remover</button></div>)}<button type="button" className="text-button" onClick={()=>updateRule({ordinalWeekdays:[...(draft.rule.ordinalWeekdays??[]),{weekday:1,ordinal:1}]})}><Plus size={14}/> Adicionar padrão</button></fieldset></>}
   <div className="date-fields"><label>Termina em (opcional)<input type="date" value={draft.rule.endDate ?? ''} onChange={e=>updateRule({endDate:e.target.value||null})}/></label><label>Horário do lembrete (Belém)<input type="time" value={draft.reminderTime ?? ''} onChange={e=>setDraft({...draft,reminderTime:e.target.value||null})}/></label></div>
   <label>Prazo após a ocorrência (dias)<input type="number" min="0" max="36500" value={draft.deadlineOffset ?? ''} onChange={e=>setDraft({...draft,deadlineOffset:e.target.value===''?null:Number(e.target.value)})}/></label>
   <label className="inline-check"><input type="checkbox" checked={!!draft.rule.paused} onChange={e=>updateRule({paused:e.target.checked})}/> Pausar este modelo</label>
   {error && <p className="save-error" role="alert">{error}</p>}<button className="primary full" disabled={saving}>{saving?'Salvando…':'Salvar repetição'}</button>
  </form>}
 </section>;
}
