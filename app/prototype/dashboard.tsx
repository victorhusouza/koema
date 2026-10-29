'use client';
// Validated visual with persistent task and briefing data.
import { useEffect, useRef, useState } from 'react';
import { localDay, addDays, dateLabel, todayTasks, upcoming, isToday } from '../../lib/task-dates';
import { capitalizeInitial } from '../../lib/text';
import { ArrowDown, ArrowLeft, ArrowRight, BookOpen, CalendarDays, Check, ChevronDown, ChevronRight, Clock3, Folder, GripVertical, HardDrive, Inbox, Leaf, LogOut, Menu, MoreHorizontal, Plus, Search, Sun, X, Bell, CalendarClock } from 'lucide-react';

import BriefingPanel from '../../components/briefing-panel';
import BackupPanel from '../../components/backup-panel';
import OrganizationPanel from '../../components/organization-panel';
import OrganizationDialog, { type OrganizationDialogState } from '../../components/organization-dialog';
import SchedulesPanel from '../../components/schedules-panel';
import PushNotificationSettings from '../../components/push-notification-settings';
import TaskMetadataFields from '../../components/task-metadata-fields';
import { type Task } from '../../lib/tasks';
import { type Area, type Project, type Tag } from '../../lib/task-store';
import { type ManualEvent } from '../../lib/events';
import { searchWorkspace } from '../../lib/workspace-search';
type GoogleCalendarEvent = { id: string; title: string; date: string; time: string | null; endTime: string | null; allDay: boolean; meetingUrl: string | null };
type GoogleCalendarStatus = { configured: boolean; source: 'ical' | 'oauth' | null; oauthConfigured: boolean; oauthConnected: boolean };
const nav = [{ name: 'Visão do dia', icon: Sun }, { name: 'Caixa de entrada', icon: Inbox }, { name: 'Algum dia', icon: Leaf }, { name: 'Logbook', icon: BookOpen }, { name: 'Histórico de briefings', icon: Clock3 }];
function recurrenceLabel(recurrence: NonNullable<Task['recurrence']>): string {
 return ({daily:'Diária',weekdays:'Dias de semana',weekends:'Fins de semana',weekly:'Semanal',monthly:'Mensal'})[recurrence];
}
function isAnytime(task:Task){return ['Algum dia','Anytime','Someday'].includes(task.when);}

export default function Prototype() {
 const [today,setToday]=useState(localDay());
 const [plannedDate,setPlannedDate]=useState('');
 const [deadline,setDeadline]=useState('');
 useEffect(()=>{const tick=()=>setToday(localDay());const timer=setInterval(tick,30000);window.addEventListener('focus',tick);return()=>{clearInterval(timer);window.removeEventListener('focus',tick);};},[]);
 useEffect(()=>{if('serviceWorker' in navigator)void navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{});},[]);
 useEffect(() => {
  const renew = async () => {
   try {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    if (!response.ok || (await response.json()).authenticated !== true) {
     window.location.assign('/login');
    }
   } catch {
    // Keep the current view during a transient network failure.
   }
  };
  void renew();
  const timer = setInterval(() => void renew(), 5 * 60 * 1000);
  window.addEventListener('focus', renew);
  return () => {
   clearInterval(timer);
   window.removeEventListener('focus', renew);
  };
 }, []);
 const [tasks, setTasks] = useState<Task[]>([]);
 const [areas,setAreas]=useState<Area[]>([]);
 const [projects,setProjects]=useState<Project[]>([]);
 const [tags,setTags]=useState<Tag[]>([]);
 const [projectHeadings,setProjectHeadings]=useState<import('../../lib/task-store').Heading[]>([]);
 const [taskDraft, setTaskDraft] = useState<Task | null>(null);
 const [loading, setLoading] = useState(true);
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState('');
 async function loadTasks() {
  setLoading(true); setError('');
  try { const response = await fetch('/api/tasks', {cache:'no-store'}); const body = await response.json(); if (!response.ok) throw new Error(body.error); setTasks(body); }
  catch (error) { setError(error instanceof Error ? error.message : 'Não foi possível carregar as tarefas.'); }
  finally {setLoading(false);}
 }
 async function loadOrganization() {
  try { const [areaResponse,projectResponse,tagResponse]=await Promise.all([fetch('/api/areas',{cache:'no-store'}),fetch('/api/projects',{cache:'no-store'}),fetch('/api/tags',{cache:'no-store'})]); const [areaBody,projectBody,tagBody]=await Promise.all([areaResponse.json(),projectResponse.json(),tagResponse.json()]); if(!areaResponse.ok)throw new Error(areaBody.error); if(!projectResponse.ok)throw new Error(projectBody.error); if(!tagResponse.ok)throw new Error(tagBody.error);setAreas(areaBody);setProjects(projectBody);setTags(tagBody); }
  catch(error){setError(error instanceof Error?error.message:'Não foi possível carregar áreas e projetos.');}
 }
 useEffect(() => { void loadTasks(); void loadOrganization(); }, []);
 const [agendaDay, setAgendaDay] = useState(0);
 const agendaDate = addDays(today, agendaDay);
 const agendaRequest = useRef(0);
 async function loadEvents(date = agendaDate) {
  const requestId = ++agendaRequest.current;
  setEventLoading(true); setEventError('');
  try { const response = await fetch('/api/events?date=' + encodeURIComponent(date), {cache:'no-store'}); const body = await response.json(); if (!response.ok) throw new Error(body.error); if(requestId === agendaRequest.current) setEvents(body); }
  catch (error) { if(requestId === agendaRequest.current) setEventError(error instanceof Error ? error.message : 'Não foi possível carregar os compromissos.'); }
  try {
   const [statusResponse, eventsResponse] = await Promise.all([fetch('/api/calendar-feed',{cache:'no-store'}),fetch('/api/calendar-feed/events?date='+encodeURIComponent(date),{cache:'no-store'})]);
   const statusBody = await statusResponse.json(); const eventsBody = await eventsResponse.json();
   if (!statusResponse.ok) throw new Error(statusBody.error || 'Não foi possível verificar a conexão com o Google.');
   if(requestId !== agendaRequest.current) return;
   setGoogleStatus({configured:!!statusBody.configured,source:statusBody.source||null,oauthConfigured:!!statusBody.oauthConfigured,oauthConnected:!!statusBody.oauthConnected});
   if (!eventsResponse.ok) throw new Error(eventsBody.error || 'Não foi possível atualizar os eventos do Google Agenda.');
   setGoogleEvents(eventsBody.events || []); setGoogleError('');
  } catch (error) {if(requestId !== agendaRequest.current) return;setGoogleEvents([]);setGoogleError(error instanceof Error ? error.message : 'Não foi possível atualizar os eventos do Google Agenda.');}
  finally { if(requestId === agendaRequest.current) setEventLoading(false); }
 }
 const loadEventsRef = useRef(loadEvents);
 useEffect(() => { loadEventsRef.current = loadEvents; }, [loadEvents]);
 useEffect(() => { void loadEvents(agendaDate); }, [agendaDate]);
 useEffect(() => {
  const refresh = () => { if (document.visibilityState === 'visible') void loadEventsRef.current(); };
  const interval = setInterval(refresh, 15 * 60 * 1000);
  window.addEventListener('focus', refresh);
  return () => { clearInterval(interval); window.removeEventListener('focus', refresh); };
 }, []);
 async function requestEvent(method: string, path: string, input?: unknown) {
  const response = await fetch('/api/events' + path, {method, headers:{'Content-Type':'application/json'}, body:input === undefined ? undefined : JSON.stringify(input)});
  const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Não foi possível salvar o compromisso.'); return body;
 }
 async function requestTask(method: string, path: string, input?: unknown) {
  const response = await fetch('/api/tasks' + path, {method, headers:{'Content-Type':'application/json'}, body:input === undefined ? undefined : JSON.stringify(input)});
  const body = await response.json(); if (!response.ok) { const error = new Error(body.error || 'Não foi possível salvar.') as Error & {status:number; body:any}; error.status=response.status; error.body=body; throw error; } return body;
 }
 async function requestOrganization(path:string,method:string,input?:unknown) {
  const response=await fetch('/api/'+path,{method,headers:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});const body=await response.json();if(!response.ok)throw new Error(body.error||'Não foi possível salvar.');return body;
 }
 async function refreshOrganization(){try{const [areaResponse,projectResponse,tagResponse]=await Promise.all([fetch('/api/areas',{cache:'no-store'}),fetch('/api/projects',{cache:'no-store'}),fetch('/api/tags',{cache:'no-store'})]);const [areaBody,projectBody,tagBody]=await Promise.all([areaResponse.json(),projectResponse.json(),tagResponse.json()]);if(!areaResponse.ok||!projectResponse.ok||!tagResponse.ok)throw new Error(areaBody.error||projectBody.error||tagBody.error||'Não foi possível carregar áreas, projetos e etiquetas.');setAreas(areaBody);setProjects(projectBody);setTags(tagBody);}catch(error){setError(error instanceof Error?error.message:'Não foi possível atualizar áreas, projetos e etiquetas.');}}
 async function saveArea(name:string,tagIds:number[]=[]){await requestOrganization('areas','POST',{name,tagIds});await refreshOrganization();setNotice('Área criada.');}
 async function renameSavedArea(areaId:number,name:string,tagIds:number[]=[]){await requestOrganization('areas/'+areaId,'PATCH',{name,tagIds});await refreshOrganization();await loadTasks();setNotice('Área renomeada.');}
 async function saveProject(input:{name:string;areaId:number|null;notes:string;plannedDate:string|null;deadline:string|null;tagIds:number[]}){await requestOrganization('projects','POST',input);await refreshOrganization();setNotice('Projeto criado.');}
 async function updateProject(projectId:number,input:{name:string;areaId:number|null;notes:string;plannedDate:string|null;deadline:string|null;tagIds:number[]}){await requestOrganization('projects/'+projectId,'PATCH',input);await refreshOrganization();await loadTasks();setNotice('Projeto atualizado.');}
 async function setProjectStatus(projectId:number,status:'open'|'completed'){await requestOrganization('projects/'+projectId,'PATCH',{status});await refreshOrganization();setNotice(status==='completed'?'Projeto concluído.':'Projeto reaberto.');}
 function organizationTaskCount(scope:{areaId?:number;projectId?:number}){return tasks.filter(task=>!task.done&&(scope.projectId!==undefined?task.projectId===scope.projectId:task.areaId===scope.areaId)).length;}
 async function saveTask(id: number, patch: Partial<Task>) {
  if (saving) return false;
  setSaving(true); setError('');
  try { const saved = await requestTask('PATCH','/' + id,patch); setTasks(current => current.map(t => t.id === id ? saved : t)); setTaskDraft(saved); return true; }
  catch (error) {setError(error instanceof Error ? error.message : 'Não foi possível salvar.'); return false;}
  finally {setSaving(false);}
 }
 async function deleteTask(id: number) {
  if (saving) return;
  setSaving(true); setError('');
  try {await requestTask('DELETE','/' + id); setTasks(current => current.filter(t => t.id !== id)); setEditing(null); setNotice('Tarefa excluída.');}
  catch (error) {setError(error instanceof Error ? error.message : 'Não foi possível excluir.');}
  finally {setSaving(false);}
 }
 const [view, setView] = useState('Visão do dia');
 useEffect(()=>{if(!view.startsWith('project:')){setProjectHeadings([]);return;}let active=true;void fetch(`/api/headings?projectId=${Number(view.slice(8))}`,{cache:'no-store'}).then(async response=>{const body=await response.json();if(!response.ok)throw new Error(body.error);if(active)setProjectHeadings(body);}).catch(error=>{if(active)setError(error instanceof Error?error.message:'Não foi possível carregar as seções do projeto.');});return()=>{active=false;};},[view]);
 const [menu, setMenu] = useState(false);
 const [query, setQuery] = useState('');
 const [taskTagFilter,setTaskTagFilter]=useState<number|null>(null);
 const [search, setSearch] = useState(false);
 const [modal, setModal] = useState<'task' | 'event' | 'calendar' | null>(null);
 const [organizationDialog, setOrganizationDialog] = useState<OrganizationDialogState | null>(null);
 const organizationOpener = useRef<HTMLElement | null>(null);
 function openOrganizationDialog(dialog:OrganizationDialogState){organizationOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setOrganizationDialog(dialog);}
 function openProjectDialog(initialAreaId?:number){openOrganizationDialog({kind:'project-create',initialAreaId:initialAreaId??null});}
 const [editing, setEditing] = useState<number | null>(null);
 const [title, setTitle] = useState('');
 const [when, setWhen] = useState('Caixa de entrada');
 const [destinationAreaId,setDestinationAreaId]=useState<number|null>(null);
 const [destinationProjectId,setDestinationProjectId]=useState<number|null>(null);
 const [destinationTagIds,setDestinationTagIds]=useState<number[]>([]);
 const [destinationHeadingId,setDestinationHeadingId]=useState<number|null>(null);
 const [destinationReminderAt,setDestinationReminderAt]=useState<string|null>(null);
 const [recurrence, setRecurrence] = useState<Task['recurrence']>(null);
 const [dragId, setDragId] = useState<number | null>(null);
 const [events, setEvents] = useState<ManualEvent[]>([]);
 const [googleEvents,setGoogleEvents]=useState<GoogleCalendarEvent[]>([]);
 const [googleStatus,setGoogleStatus]=useState<GoogleCalendarStatus>({configured:false,source:null,oauthConfigured:false,oauthConnected:false});
 const [googleError,setGoogleError]=useState('');
 const [icalUrl,setIcalUrl]=useState('');
 const [calendarSaving,setCalendarSaving]=useState(false);
 const [eventTime, setEventTime] = useState('');
 const [eventDate, setEventDate] = useState(today);
 const [editingEvent, setEditingEvent] = useState<number | null>(null);
 const [eventLoading, setEventLoading] = useState(true);
 const [eventSaving, setEventSaving] = useState(false);
 const [eventError, setEventError] = useState('');
 const [notice, setNotice] = useState('');
 const [logoutPending, setLogoutPending] = useState(false);
 const [logoutError, setLogoutError] = useState('');
 useEffect(() => { function onKey(event: KeyboardEvent) { if (event.key === 'Escape') { if (organizationDialog) return; setModal(null); setEditing(null); setMenu(false); } } window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [organizationDialog]);
 useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timeout); }, [notice]);
 const selected = taskDraft?.id === editing ? taskDraft : tasks.find(t => t.id === editing);
 const lockedHistory = !!selected?.done && selected.seriesId !== undefined;
 function updateTask(id: number, patch: Partial<Task>) { setTaskDraft(current => current && current.id === id ? {...current,...patch} : {...tasks.find(t => t.id === id)!,...patch}); }
 async function complete(task: Task) {
  if (saving) return;
  setError('');
  if (!task.done) {
   if (await saveTask(task.id, {title:task.title, notes:task.notes, checklist:task.checklist, plannedDate:task.plannedDate,deadline:task.deadline,done:true})) {
    await loadTasks(); setNotice('Tarefa movida para o Logbook.'); setEditing(null);
   }
   return;
  }
  if (task.seriesId !== undefined) {
   setSaving(true);
   try {
    let result;
    try { result = await requestTask('POST',`/${task.id}/reopen`,{}); }
    catch (error) {
     const conflict = error as Error & {status?:number; body?:any};
     if (conflict.status === 409 && conflict.body?.conflict === 'edited-successor' && window.confirm(`${conflict.message}\n\nSubstituir a próxima ocorrência pelas alterações desta tarefa?`)) {
      result = await requestTask('POST',`/${task.id}/reopen`,{successorId:conflict.body.successorId,successorFingerprint:conflict.body.successorFingerprint});
     } else throw error;
    }
    setTasks(result.tasks); setNotice('Tarefa reaberta.'); setEditing(null);
   } catch (error) {setError(error instanceof Error ? error.message : 'Não foi possível reabrir a tarefa.');}
   finally {setSaving(false);}
   return;
  }
  if (await saveTask(task.id, {done:false})) {setNotice('Tarefa reaberta.'); setEditing(null);}
 }
 function completionLabel(value?: string) { if (!value) return ''; return new Intl.DateTimeFormat('pt-BR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'America/Belem'}).format(new Date(value)); }

 function go(value: string) { setView(value); setMenu(false); setQuery(''); setTaskTagFilter(null); setSearch(false); }
 function newTask(destination = 'Caixa de entrada', areaId:number|null=null, projectId:number|null=null) { setTitle(''); setWhen(destination); setDestinationAreaId(areaId);setDestinationProjectId(projectId);setDestinationTagIds([]);setDestinationHeadingId(null);setDestinationReminderAt(null); setPlannedDate(destination==='Hoje' ? today : ''); setDeadline(''); setRecurrence(null); setModal('task'); }
 async function reorderTask(source: number,target: number) {
  if(saving || source===target) return;
  const order=todayTasks(tasks,today).map(t=>t.id);
  const from=order.indexOf(source), to=order.indexOf(target);if(from<0 || to<0)return;
  order.splice(to,0,...order.splice(from,1));setSaving(true);setError('');
  try{const saved=await requestTask('PUT','/order',order);setTasks(saved);}
  catch(error){setError(error instanceof Error ? error.message : 'Não foi possível salvar a ordem.');}
  finally{setSaving(false);}
 }
 function row(task: Task) { return <div key={task.id} className={'task-row ' + (task.done ? 'completed' : '')} draggable={!saving && view === 'Visão do dia' && isToday(task,today)} onDragStart={() => setDragId(task.id)} onDragOver={e => e.preventDefault()} onDrop={() => { if(dragId!==null) void reorderTask(dragId,task.id);setDragId(null); }}>
  <GripVertical size={14} className="grip" aria-hidden="true"/><button disabled={saving || loading} className={'checkbox ' + (task.done ? 'checked' : '')} aria-label={(task.done ? 'Reabrir ' : 'Concluir ') + task.title} onClick={() => complete(task)}>{task.done && <Check size={13}/>}</button>
  <button className="task-body" onClick={() => {setTaskDraft(structuredClone(task)); setEditing(task.id);}}><span>{task.title}</span><small>{task.project || 'Sem projeto'}{task.recurrence && <span> · {recurrenceLabel(task.recurrence)}</span>}{task.reminderAt&&<span> · Lembrete {new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Belem'}).format(new Date(task.reminderAt))}</span>}{task.checklist.length > 0 && <span className="checklist-count"> · {task.checklist.filter(c => c.done).length}/{task.checklist.length} passos</span>}{task.effectiveTagIds?.map(tagId=>tags.find(tag=>tag.id===tagId)).filter(Boolean).map(tag=><span className="task-tag-label" key={tag!.id}> · {tag!.name}</span>)}</small></button>
  <span className="task-date">{task.done ? completionLabel(task.completed) : <>{task.deadline && <span className={task.deadline<today ? 'overdue' : ''}>Prazo: {dateLabel(task.deadline,today)}<br/></span>}{isAnytime(task)?'Algum dia':task.plannedDate ? task.plannedDate<today ? 'Planejada: '+dateLabel(task.plannedDate,today) : task.plannedDate===today ? '' : dateLabel(task.plannedDate,today) : task.when}</>}</span><ChevronRight className="row-arrow" size={15}/>
 </div>; }

 const hasSearchQuery = !!query.trim();
 const isHome = view === 'Visão do dia' && !hasSearchQuery;
 const searchResults = searchWorkspace(query, tasks, projects);
 const filtered = tasks.filter(t => (query ? t.title.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR')) : view === 'Logbook' ? t.done : !t.done && (view === 'Caixa de entrada' ? !t.plannedDate && !isAnytime(t) : view === 'Algum dia' ? isAnytime(t) : view.startsWith('area:') ? t.areaId===Number(view.slice(5)) : view.startsWith('project:') ? t.projectId===Number(view.slice(8)) : true)) && (taskTagFilter===null || (t.effectiveTagIds??[]).includes(taskTagFilter)));
 const viewLabel = view.startsWith('area:') ? areas.find(a=>a.id===Number(view.slice(5)))?.name || 'Área' : view.startsWith('project:') ? projects.find(p=>p.id===Number(view.slice(8)))?.name || 'Projeto' : view;
 const activeProject=view.startsWith('project:')?projects.find(project=>project.id===Number(view.slice(8))):undefined;
 async function logout() {
  if (logoutPending) return;
  setLogoutPending(true);
  setLogoutError('');
  try {
   const response = await fetch('/api/auth/logout', { method: 'POST' });
   if (!response.ok) throw new Error('Não foi possível encerrar a sessão. Tente novamente.');
   window.location.assign('/login');
  } catch (cause) {
   setLogoutError(cause instanceof Error ? cause.message : 'Não foi possível encerrar a sessão. Tente novamente.');
   setLogoutPending(false);
  }
 }
 return <div className="app">
  <header className="topbar"><div className="brand"><button className="icon-button" aria-label="Abrir navegação" onClick={() => setMenu(!menu)}><Menu size={19}/></button><span className="brand-symbol"><Sun size={22}/></span><span>Koema<span className="brand-dot">.</span></span></div><div className="top-actions"><span className="local-status"><span/> Espaço pessoal</span><button className="icon-button" aria-label="Buscar tarefas e projetos" onClick={() => setSearch(!search)}><Search size={18}/></button><button className="icon-button" aria-label="Sair da conta" title="Sair" disabled={logoutPending} onClick={()=>void logout()}><LogOut size={17}/></button></div></header>
  {menu && <><button className="scrim" aria-label="Fechar navegação" onClick={() => setMenu(false)}/><aside className="sidebar"><div className="sidebar-title">Seu espaço <button className="icon-button" aria-label="Fechar menu" onClick={() => setMenu(false)}><X size={17}/></button></div>{nav.map(({name, icon: Icon}) => <button key={name} className={'nav-item ' + (view === name ? 'active' : '')} onClick={() => go(name)}><Icon size={17}/>{name}</button>)}<p className="nav-caption">ÁREAS E PROJETOS <button className="icon-button" aria-label="Nova área" onClick={()=>openOrganizationDialog({kind:'area-create'})}><Plus size={15}/></button></p>{areas.map(area=><div key={area.id}><button className={'nav-item '+(view===`area:${area.id}`?'active':'')} onClick={() => go(`area:${area.id}`)}><Folder size={16}/>{area.name}</button>{projects.filter(project=>project.areaId===area.id).map(project=><button key={project.id} className={'nav-item indented '+(view===`project:${project.id}`?'active':'')} onClick={() => go(`project:${project.id}`)}><Folder size={15}/>{project.name}{project.status==='completed'?' ✓':''}</button>)}</div>)}{projects.some(project=>project.areaId===null)&&<><p className="nav-caption">SEM ÁREA</p>{projects.filter(project=>project.areaId===null).map(project=><button key={project.id} className={'nav-item indented '+(view===`project:${project.id}`?'active':'')} onClick={()=>go(`project:${project.id}`)}><Folder size={15}/>{project.name}{project.status==='completed'?' ✓':''}</button>)}</>}<button className="nav-item" onClick={()=>openOrganizationDialog({kind:'area-create'})}><Plus size={16}/> Nova área</button><button className="nav-item" onClick={()=>openProjectDialog()}><Plus size={16}/> Novo projeto</button><button className="nav-item" onClick={()=>go('Organização')}><MoreHorizontal size={16}/> Gerenciar</button><button className={'nav-item '+(view==='Backup e restauração'?'active':'')} onClick={()=>go('Backup e restauração')}><HardDrive size={16}/> Backup e restauração</button><button className={'nav-item '+(view==='Repetições'?'active':'')} onClick={()=>go('Repetições')}><CalendarClock size={16}/> Repetições</button><button className={'nav-item '+(view==='Notificações'?'active':'')} onClick={()=>go('Notificações')}><Bell size={16}/> Notificações</button><div className="sidebar-note">Painel pessoal<br/>Briefings salvos por data</div></aside></>}
  <main>
   <div className="prototype-notice"><span className="tiny-dot"/> EM DESENVOLVIMENTO <span>Tarefas, briefings e compromissos em um só lugar</span></div>
   {error && <div className="save-error" role="alert">{error} <button onClick={() => void loadTasks()}>Recarregar tarefas</button></div>}
   {loading && <p role="status" className="muted">Carregando suas tarefas…</p>}
   <div className="greeting"><div><p className="eyebrow">{new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(today+'T12:00:00Z')).toLocaleUpperCase('pt-BR')}</p><h1>{view === 'Visão do dia' ? 'Bom dia, Victor.' : viewLabel}<span className="greeting-dot">{view === 'Visão do dia' ? '' : '.'}</span></h1><p className="subtitle">{view === 'Visão do dia' ? 'Seu dia, com espaço para o que importa.' : view === 'Logbook' ? 'Um registro do que você já tirou do caminho.' : 'Tudo no seu tempo. Uma coisa de cada vez.'}</p></div><Sun className="greeting-sun" size={48} strokeWidth={1}/></div>
   {search && <div className="searchbox"><Search size={18}/><input autoFocus placeholder="Buscar tarefas e projetos…" aria-label="Buscar tarefas e projetos" value={query} onChange={e => setQuery(e.currentTarget.value)}/><button className="icon-button" aria-label="Limpar busca" onClick={() => { setQuery(''); setSearch(false); }}><X size={16}/></button></div>}
   {hasSearchQuery ? <section className="card search-results" aria-label="Resultados da busca"><div className="section-top"><h2>Resultados da busca</h2></div>{searchResults.map(result => <button key={`${result.kind}-${result.id}`} className="project-result" onClick={() => {
    if (result.kind === 'project') { go(`project:${result.id}`); return; }
    const task = tasks.find(item => item.id === result.id);
    if (task) { setTaskDraft(structuredClone(task)); setEditing(task.id); setQuery(''); setSearch(false); }
   }}>{result.kind === 'project' ? <Folder size={18}/> : <Check size={18}/>}<span className="search-result-copy"><strong>{result.kind === 'project' ? `Projeto · ${result.title}` : result.title}</strong><small>{result.kind === 'project' ? `${result.context}${result.completed ? ' · Concluído' : ''}` : `${result.context}${result.done ? ' · Concluída' : ''}`}</small></span><ChevronRight size={16}/></button>)}{!searchResults.length && <p className="empty">Nenhuma tarefa ou projeto encontrado.</p>}</section> : isHome ? <>
    <BriefingPanel mode="today" />
    <section className="card schedule"><div className="section-top"><h2><CalendarDays size={18}/> Na sua agenda</h2><button className="icon-button" aria-label="Adicionar compromisso" onClick={() => { setTitle(''); setEventTime(''); setEventDate(agendaDate); setEditingEvent(null); setEventError(''); setModal('event'); }}><Plus size={18}/></button></div><div className="agenda-days" role="group" aria-label="Dia da agenda">{['Hoje','Amanhã'].map((label,index)=><button key={label} aria-pressed={agendaDay===index} onClick={()=>setAgendaDay(index)}>{label}</button>)}</div>{eventError && <p className="save-error" role="alert">{eventError} <button onClick={() => void loadEvents()}>Recarregar compromissos</button></p>}{googleError && <p className="save-error" role="alert">{googleError} <button onClick={() => void loadEvents()}>Atualizar Google Agenda</button></p>}<div className="events">{eventLoading ? <p className="empty" role="status">Carregando compromissos…</p> : <>{events.map(event => <div className="event" key={'manual-'+event.id}><div className="event-time">{event.time || 'Dia todo'}</div><span className="event-line"/><button className="event-details" aria-label={'Editar compromisso: ' + event.title} onClick={() => {setEditingEvent(event.id);setTitle(event.title);setEventDate(event.date);setEventTime(event.time || '');setEventError('');setModal('event');}}><strong>{event.title}</strong><small>Compromisso manual · editar</small></button><span className="event-icon"><Clock3 size={17}/></span></div>)}{googleEvents.map(event => <div className="event" key={'google-'+event.id}><div className="event-time">{event.allDay ? 'Dia todo' : event.time}{event.endTime && <small>até {event.endTime}</small>}</div><span className="event-line purple"/><div className="event-details"><strong>{capitalizeInitial(event.title)}</strong><small>Google Agenda · somente leitura</small></div>{event.meetingUrl ? <a className="event-icon" href={event.meetingUrl} target="_blank" rel="noreferrer" aria-label={'Abrir reunião: '+event.title}><CalendarDays size={17}/></a> : <span className="event-icon"><CalendarDays size={17}/></span>}</div>)}{!events.length && !googleEvents.length && <p className="empty">{googleError ? 'Os eventos não puderam ser carregados.' : agendaDay === 0 ? 'Nenhum compromisso para hoje.' : 'Nenhum compromisso para amanhã.'}</p>}</>}</div><div className="calendar-controls"><button className="calendar-status" onClick={() => setModal('calendar')}><span className="google-mark">G</span> Google Agenda <span>{googleStatus.source === 'ical' ? 'iCal · somente leitura' : googleStatus.source === 'oauth' ? 'Google · somente leitura' : googleStatus.configured ? 'iCal salvo' : 'Configurar iCal'}</span><ChevronRight size={14}/></button>{<button className="calendar-action" disabled={eventLoading} onClick={() => void loadEvents()}>{eventLoading?'Atualizando…':'Atualizar'}</button>}</div></section>
    <section className="card today"><div className="section-top"><h2><Sun size={19} className="gold"/> Hoje <span className="section-hint">Um passo de cada vez</span></h2><button className="text-button" onClick={() => newTask('Hoje')}><Plus size={16}/> Nova tarefa</button></div><div>{todayTasks(tasks,today).map(row)}</div>{todayTasks(tasks,today).length===0 && <p className="empty">Tudo em dia. Aproveite esse espaço.</p>}<button className="add-row" onClick={() => newTask('Hoje')}><Plus size={17}/> Adicionar uma tarefa para hoje</button></section>
    <section className="card upcoming"><div className="section-top"><h2><ArrowRight size={18}/> Upcoming</h2><span className="section-hint">O que vem a seguir</span></div><div className="upcoming-scroll" tabIndex={0} aria-label="Próximas tarefas; role para ver mais">{upcoming(tasks,today).map(row)}</div><div className="scroll-hint"><ArrowDown size={12}/> Role para ver as próximas tarefas</div></section>
   </> : view === 'Histórico de briefings' && !query ? <BriefingPanel mode="history" /> : view === 'Organização' && !query ? <><BriefingPanel mode="hidden"/><OrganizationPanel areas={areas} projects={projects} tags={tags} onChanged={()=>{void refreshOrganization();void loadTasks();}} openTaskCount={organizationTaskCount} onCreateArea={() => openOrganizationDialog({kind:'area-create'})} onRenameArea={area => openOrganizationDialog({kind:'area-rename',area})} onCreateProject={openProjectDialog} onEditProject={project => openOrganizationDialog({kind:'project-edit',project})} onSetProjectStatus={project => openOrganizationDialog({kind:'project-status',project,openTaskCount:organizationTaskCount({projectId:project.id})})}/></> : view === 'Backup e restauração' && !query ? <><BriefingPanel mode="hidden"/><BackupPanel/></> : view === 'Repetições' && !query ? <><BriefingPanel mode="hidden"/><SchedulesPanel areas={areas} projects={projects} tags={tags} onChanged={()=>void loadTasks()}/></> : view === 'Notificações' && !query ? <><BriefingPanel mode="hidden"/><PushNotificationSettings/></> : <><BriefingPanel mode="hidden"/><section className="card list-view"><div className="section-top"><h2>{query ? 'Resultados da busca' : viewLabel}</h2>{tags.length>0&&<select className="tag-filter" aria-label="Filtrar por etiqueta" value={taskTagFilter??''} onChange={event=>setTaskTagFilter(event.currentTarget.value?Number(event.currentTarget.value):null)}><option value="">Todas as etiquetas</option>{tags.map(tag=><option key={tag.id} value={tag.id}>{tag.name}</option>)}</select>}{view !== 'Logbook' && <button className="text-button" onClick={() => {const area=areas.find(item=>`area:${item.id}`===view);const project=projects.find(item=>`project:${item.id}`===view);newTask(view === 'Algum dia' ? view : 'Caixa de entrada',project?.areaId??area?.id??null,project?.id??null);}}><Plus size={16}/> Nova tarefa</button>}</div>{activeProject&&<div className="project-summary">{(activeProject.plannedDate||activeProject.deadline)&&<div className="project-summary-dates">{activeProject.plannedDate&&<span>Planejado: {new Intl.DateTimeFormat('pt-BR',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${activeProject.plannedDate}T12:00:00Z`))}</span>}{activeProject.deadline&&<span>Prazo: {new Intl.DateTimeFormat('pt-BR',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${activeProject.deadline}T12:00:00Z`))}</span>}</div>}{activeProject.notes&&(activeProject.notes.length>180?<details><summary>Notas do projeto</summary><p>{activeProject.notes}</p></details>:<p>{activeProject.notes}</p>)}</div>}{view.startsWith('project:') ? <><div className="project-loose-tasks">{filtered.filter(task=>!task.headingId).map(row)}</div>{projectHeadings.map(heading=>{const items=filtered.filter(task=>task.headingId===heading.id);return <section className="project-task-group" key={heading.id}><div className="project-task-heading"><h3>{heading.title||'Sem título'}</h3><span>{items.length}</span></div>{items.map(row)}</section>})}</> : filtered.map(row)}{!filtered.length && <p className="empty">{query ? 'Nenhuma tarefa encontrada.' : 'Nada por aqui, por enquanto.'}</p>}</section></>}
   <footer><Leaf size={14}/><span>Menos ruído. Mais presença.</span><span className="footer-right">Feito para o seu ritmo.</span></footer>
  </main>

  {notice && <div className="toast" role="status"><Check size={16}/>{notice}</div>}
  {logoutError && <div className="toast save-error" role="alert">{logoutError}</div>}
  {organizationDialog && <OrganizationDialog dialog={organizationDialog} areas={areas} tags={tags} returnFocusTarget={organizationOpener.current} onClose={() => setOrganizationDialog(null)} onCreateArea={saveArea} onRenameArea={renameSavedArea} onCreateProject={saveProject} onEditProject={updateProject} onSetProjectStatus={setProjectStatus}/>}
  {(modal || selected) && <div className="modal-backdrop" onClick={() => { setModal(null); setEditing(null); }}><section className="modal" role="dialog" aria-modal="true" aria-label={selected ? 'Detalhes da tarefa' : modal === 'event' ? (editingEvent===null?'Novo compromisso':'Editar compromisso') : modal === 'calendar' ? 'Google Agenda' : 'Nova tarefa'} onClick={e => e.stopPropagation()}><div className="section-top"><h2>{selected ? 'Detalhes da tarefa' : modal === 'event' ? (editingEvent===null?'Novo compromisso':'Editar compromisso') : modal === 'calendar' ? 'Google Agenda' : 'Nova tarefa'}</h2><button className="icon-button" aria-label="Fechar janela" onClick={() => { setModal(null); setEditing(null); }}><X size={19}/></button></div>
   {eventError && modal==='event' && <p className="save-error" role="alert">{eventError}</p>}{error && modal!=='event' && <p className="save-error" role="alert">{error}</p>}{selected ? <>{selected.scheduleId!==null&&selected.scheduleId!==undefined&&<div className="info-box"><CalendarClock size={19}/><span>Esta tarefa foi criada por uma repetição. As alterações salvas aqui valem para esta tarefa; o modelo continua igual. <button className="text-button" onClick={()=>{setEditing(null);go('Repetições');}}>Ver repetição</button></span></div>}<label>Título<input autoFocus readOnly={lockedHistory} value={selected.title} onChange={e => updateTask(selected.id, {title: e.currentTarget.value})}/></label><label>Notas<textarea readOnly={lockedHistory} value={selected.notes} placeholder="Um detalhe, uma ideia, um próximo passo…" onChange={e => updateTask(selected.id, {notes: e.currentTarget.value})}/></label>{selected.checklist.map((c,i) => <label className="checklist-item" key={i}><input type="checkbox" disabled={lockedHistory} checked={c.done} onChange={() => updateTask(selected.id, {checklist: selected.checklist.map((item,j) => i === j ? {...item, done: !item.done} : item)})}/>{c.text}</label>)}<label>Destino<select disabled={lockedHistory} value={isAnytime(selected)?'Algum dia':selected.plannedDate?'Planejada':'Caixa de entrada'} onChange={e=>{const value=e.currentTarget.value;if(value==='Algum dia')updateTask(selected.id,{when:value,plannedDate:null});else if(value==='Caixa de entrada')updateTask(selected.id,{when:value,plannedDate:null});else updateTask(selected.id,{when:'Planejada',plannedDate:selected.plannedDate||today});}}><option>Caixa de entrada</option><option>Planejada</option><option>Algum dia</option></select></label><div className="date-fields"><label>Quando fazer<input disabled={lockedHistory || selected.when==='Algum dia'} type="date" value={selected.plannedDate || ''} onInput={e=>updateTask(selected.id,{plannedDate:e.currentTarget.value || null,when:e.currentTarget.value?'Planejada':'Caixa de entrada'})}/></label><label>Prazo final<input disabled={lockedHistory} type="date" value={selected.deadline || ''} onInput={e=>updateTask(selected.id,{deadline:e.currentTarget.value || null})}/></label></div><label>Área<select disabled={lockedHistory} value={selected.areaId??''} onChange={e=>updateTask(selected.id,{areaId:e.currentTarget.value?Number(e.currentTarget.value):null,projectId:null,headingId:null})}><option value="">Avulsa</option>{areas.map(area=><option key={area.id} value={area.id}>{area.name}</option>)}</select></label><label>Projeto<select disabled={lockedHistory} value={selected.projectId??''} onChange={e=>{const projectId=e.currentTarget.value?Number(e.currentTarget.value):null;const project=projects.find(value=>value.id===projectId);updateTask(selected.id,{projectId,areaId:project?.areaId??selected.areaId??null,headingId:null});}}><option value="">{selected.areaId?'Somente na área':'Sem projeto'}</option>{projects.filter(project=>project.areaId===(selected.areaId??null)).map(project=><option key={project.id} value={project.id}>{project.name}{project.status==='completed'?' · Concluído':''}</option>)}</select></label>{selected.scheduleId==null&&<label>Repetição<select disabled={saving || selected.done} value={selected.recurrence || ''} onChange={e=>updateTask(selected.id,{recurrence:['daily','weekdays','weekends','weekly','monthly'].includes(e.currentTarget.value) ? e.currentTarget.value as NonNullable<Task['recurrence']> : null})}><option value="">Sem repetição</option><option value="daily">Diária</option><option value="weekdays">Dias de semana</option><option value="weekends">Fins de semana</option><option value="weekly">Semanal</option><option value="monthly">Mensal</option></select><small className="muted">Dias de semana inclui segunda a sexta; fins de semana inclui sábado e domingo. Uma data inicial fora do padrão passa para o próximo dia elegível. Semanal mantém o dia inicial; mensal usa o último dia nos meses curtos. Alterar a data planejada reancora séries semanais e mensais.</small></label>}<TaskMetadataFields tags={tags} projectId={selected.projectId??null} tagIds={selected.tagIds??[]} headingId={selected.headingId??null} reminderAt={selected.reminderAt??null} disabled={lockedHistory} onTagIdsChange={tagIds=>updateTask(selected.id,{tagIds})} onHeadingChange={headingId=>updateTask(selected.id,{headingId})} onReminderChange={reminderAt=>updateTask(selected.id,{reminderAt})}/>{lockedHistory && <p className="muted">Ocorrências concluídas são preservadas. Reabra esta ocorrência para editá-la.</p>}<p className="muted">{selected.project || 'Sem projeto'} · {selected.when}</p><div className="modal-actions"><button disabled={saving} className="danger-button" onClick={() => void deleteTask(selected.id)}>Excluir tarefa</button><button disabled={saving || lockedHistory} className="primary" onClick={async () => {if (await saveTask(selected.id,{title:selected.title,notes:selected.notes,checklist:selected.checklist,plannedDate:selected.plannedDate,deadline:selected.deadline,recurrence:selected.recurrence ?? null,when:selected.when,areaId:selected.areaId??null,projectId:selected.projectId??null,tagIds:selected.tagIds??[],headingId:selected.headingId??null,reminderAt:selected.reminderAt??null})) {setNotice('Alterações salvas.'); setEditing(null);}}}>{saving ? 'Salvando…' : 'Salvar alterações'}</button><button disabled={saving} className="text-button" onClick={() => void complete(selected)}>{selected.done ? 'Reabrir tarefa' : 'Concluir tarefa'}</button></div></> : modal === 'calendar' ? <><p className="dialog-copy">Eventos do Google Agenda junto ao briefing da manhã.</p><p className="muted">Cadastre o endereço secreto iCal do Google Agenda. Ele permite somente leitura e fica armazenado de forma cifrada. Não compartilhe esse endereço.</p><ol className="muted"><li>No Google Agenda, abra Configurações.</li><li>Em “Sua agenda”, selecione o calendário e abra “Integrar agenda”.</li><li>Copie “Endereço secreto no formato iCal” e cole abaixo.</li></ol><form onSubmit={async event=>{event.preventDefault();if(calendarSaving)return;setCalendarSaving(true);setGoogleError('');try{const response=await fetch('/api/calendar-feed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:icalUrl})});const body=await response.json();if(!response.ok)throw new Error(body.error||'Não foi possível salvar o acesso à agenda.');setIcalUrl('');await loadEvents();setNotice('Endereço iCal salvo e ativado.');}catch(error){setGoogleError(error instanceof Error?error.message:'Não foi possível salvar o endereço do Google Agenda.');}finally{setCalendarSaving(false);}}}><label>Endereço secreto iCal<input type="url" autoComplete="off" spellCheck={false} value={icalUrl} onChange={event=>setIcalUrl(event.currentTarget.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" required/></label>{googleError&&<p className="save-error" role="alert">{googleError}</p>}<button disabled={calendarSaving||!icalUrl.trim()} className="primary full">{calendarSaving?'Salvando…':'Salvar e consultar agenda'}</button></form>{googleStatus.configured&&<><div className="info-box"><CalendarDays size={20}/><span>Endereço salvo · somente leitura. O painel consulta ao abrir, ao voltar para a janela, a cada 15 minutos e ao escolher Atualizar.</span></div><button className="secondary" disabled={eventLoading} onClick={()=>void loadEvents()}>{eventLoading?'Atualizando…':'Atualizar eventos'}</button><button disabled={calendarSaving} className="danger-button" onClick={async()=>{setCalendarSaving(true);setGoogleError('');try{const response=await fetch('/api/calendar-feed',{method:'DELETE'});const body=await response.json();if(!response.ok)throw new Error(body.error||'Não foi possível remover o acesso salvo.');setGoogleEvents([]);await loadEvents();setNotice('Endereço iCal removido.');}catch(error){setGoogleError(error instanceof Error?error.message:'Não foi possível remover o acesso salvo.');}finally{setCalendarSaving(false);}}}>{calendarSaving?'Removendo…':'Remover endereço salvo'}</button></>}<button className="text-button full" onClick={()=>setModal(null)}>Fechar</button></> : <form onSubmit={async e => { e.preventDefault(); if (!title.trim()) return; if (modal === 'event') { if (eventSaving) return; setEventSaving(true); setEventError(''); try { const payload={title:title.trim(),date:eventDate,time:eventTime||null}; const saved=editingEvent===null ? await requestEvent('POST','',payload) : await requestEvent('PATCH','/'+editingEvent,payload); setEvents(current => saved.date===agendaDate ? [...current.filter(event=>event.id!==saved.id),saved].sort((a,b)=>(a.time?1:0)-(b.time?1:0)||(a.time||'').localeCompare(b.time||'')) : current.filter(event=>event.id!==saved.id)); setNotice(editingEvent===null?'Compromisso salvo.':'Compromisso atualizado.'); setModal(null); setEditingEvent(null); } catch(error) { setEventError(error instanceof Error?error.message:'Não foi possível salvar o compromisso.'); } finally { setEventSaving(false); } return; } else {
 if (saving) return;
 setSaving(true); setError('');
 try {const saved = await requestTask('POST','',{title,when,plannedDate:plannedDate || null,deadline:deadline || null,recurrence,areaId:destinationAreaId,projectId:destinationProjectId,tagIds:destinationTagIds,headingId:destinationHeadingId,reminderAt:destinationReminderAt}); setTasks(current => [...current,saved]); setNotice('Tarefa salva.');}
 catch (error) {setError(error instanceof Error ? error.message : 'Não foi possível salvar a tarefa.'); return;}
 finally {setSaving(false);}
 } setModal(null); }}><label>{modal === 'event' ? 'Título' : 'O que você quer fazer?'}<input autoFocus required value={title} onChange={e => setTitle(e.currentTarget.value)} placeholder={modal === 'event' ? 'Ex.: consulta de rotina' : 'Ex.: revisar a proposta'}/></label>{modal === 'event' ? <><label>Data<input type="date" required value={eventDate} onChange={e=>setEventDate(e.currentTarget.value)}/></label><label>Horário (opcional)<input type="time" value={eventTime} onChange={e => setEventTime(e.currentTarget.value)}/></label></> : <label>Quando<select value={when} onChange={e => {setWhen(e.currentTarget.value);setPlannedDate(e.currentTarget.value==='Hoje' ? today : e.currentTarget.value==='Amanhã' ? addDays(today,1) : '');}}>{['Caixa de entrada','Hoje','Amanhã','Algum dia'].map(v => <option key={v}>{v}</option>)}</select></label>}{modal==='task' && <><label>Área<select value={destinationAreaId??''} onChange={e=>{setDestinationAreaId(e.currentTarget.value?Number(e.currentTarget.value):null);setDestinationProjectId(null);}}><option value="">Avulsa</option>{areas.map(area=><option key={area.id} value={area.id}>{area.name}</option>)}</select></label><label>Projeto<select value={destinationProjectId??''} onChange={e=>{setDestinationProjectId(e.currentTarget.value?Number(e.currentTarget.value):null);setDestinationHeadingId(null);}}><option value="">{destinationAreaId?'Somente na área':'Sem projeto'}</option>{projects.filter(project=>project.areaId===(destinationAreaId??null)).map(project=><option key={project.id} value={project.id}>{project.name}{project.status==='completed'?' · Concluído':''}</option>)}</select></label><div className="date-fields"><label>Quando fazer<input type="date" value={plannedDate} onInput={e=>{setPlannedDate(e.currentTarget.value); if(e.currentTarget.value)setWhen('Caixa de entrada');}}/></label><label>Prazo final<input type="date" value={deadline} onInput={e=>setDeadline(e.currentTarget.value)}/></label></div><TaskMetadataFields tags={tags} projectId={destinationProjectId} tagIds={destinationTagIds} headingId={destinationHeadingId} reminderAt={destinationReminderAt} onTagIdsChange={setDestinationTagIds} onHeadingChange={setDestinationHeadingId} onReminderChange={setDestinationReminderAt}/><label>Repetição<select value={recurrence || ''} onChange={e=>setRecurrence(['daily','weekdays','weekends','weekly','monthly'].includes(e.currentTarget.value) ? e.currentTarget.value as NonNullable<Task['recurrence']> : null)}><option value="">Sem repetição</option><option value="daily">Diária</option><option value="weekdays">Dias de semana</option><option value="weekends">Fins de semana</option><option value="weekly">Semanal</option><option value="monthly">Mensal</option></select><small className="muted">Dias de semana inclui segunda a sexta; fins de semana inclui sábado e domingo. Uma data inicial fora do padrão passa para o próximo dia elegível. Semanal mantém o dia inicial; mensal usa o último dia nos meses curtos. Alterar a data planejada reancora séries semanais e mensais.</small></label></>}{modal==='event' && editingEvent!==null && <button type="button" disabled={eventSaving} className="danger-button" onClick={async()=>{setEventSaving(true);setEventError('');try{await requestEvent('DELETE','/'+editingEvent);setEvents(current=>current.filter(event=>event.id!==editingEvent));setNotice('Compromisso excluído.');setEditingEvent(null);setModal(null);}catch(error){setEventError(error instanceof Error?error.message:'Não foi possível excluir o compromisso.');}finally{setEventSaving(false);}}}>Excluir compromisso</button>}<button type="submit" disabled={modal==='event'?eventSaving:saving||loading} className="primary full">{modal === 'event' ? (eventSaving?'Salvando…':editingEvent===null?'Adicionar compromisso':'Salvar alterações') : 'Adicionar tarefa'}</button></form>}
  </section></div>}
 </div>;
}
