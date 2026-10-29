'use client';

import { useEffect, useState } from 'react';
import type { Tag } from '../lib/task-store';

const ZONE = 'America/Belem';
function localDateTime(value: string | null | undefined) {
 if (!value) return '';
 const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
 const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
 return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
function isoFromLocal(value: string) {
 if (!value) return null;
 const wallClock = new Date(`${value}:00Z`);
 const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(wallClock);
 const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value ?? 0);
 const represented = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
 return new Date(wallClock.getTime() - (represented - wallClock.getTime())).toISOString();
}
type Heading = { id: number; projectId: number; title: string; position: number };
type Props = {
 tags: Tag[]; projectId: number | null; tagIds: number[]; headingId: number | null; reminderAt: string | null;
 disabled?: boolean; onTagIdsChange: (value: number[]) => void; onHeadingChange: (value: number | null) => void; onReminderChange: (value: string | null) => void;
};
export default function TaskMetadataFields({ tags, projectId, tagIds, headingId, reminderAt, disabled, onTagIdsChange, onHeadingChange, onReminderChange }: Props) {
 const [headings, setHeadings] = useState<Record<number,Heading[]>>({});
 const [headingError,setHeadingError]=useState('');
 async function loadHeadings(id:number){try{const response=await fetch(`/api/headings?projectId=${id}`,{cache:'no-store'});const value=await response.json();if(!response.ok)throw new Error(value.error||'Não foi possível carregar as seções.');setHeadings(current=>({...current,[id]:value}));setHeadingError('');}catch(cause){setHeadingError(cause instanceof Error?cause.message:'Não foi possível carregar as seções.');}}
 useEffect(() => {
  if (projectId === null) { setHeadingError(''); return; }
  let active = true;
  void fetch(`/api/headings?projectId=${projectId}`, { cache: 'no-store' }).then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error||'Não foi possível carregar as seções.'); if (active) { setHeadings(current=>({...current,[projectId]:value})); setHeadingError(''); } }).catch(cause => { if (active) setHeadingError(cause instanceof Error?cause.message:'Não foi possível carregar as seções.'); });
  return () => { active = false; };
 }, [projectId]);
 const projectHeadings=projectId===null?[]:headings[projectId]??[];
 return <>
  {projectId !== null && <label>Seção<select disabled={disabled} value={headingId ?? ''} onChange={event => onHeadingChange(event.currentTarget.value ? Number(event.currentTarget.value) : null)}><option value="">Sem seção</option>{headingId!==null&&!projectHeadings.some(heading=>heading.id===headingId)&&<option value={headingId}>Seção atual</option>}{projectHeadings.map(heading => <option key={heading.id} value={heading.id}>{heading.title || 'Sem título'}</option>)}</select>{headingError&&<small className="muted" role="alert">{headingError} <button type="button" className="text-button" onClick={()=>void loadHeadings(projectId)}>Tentar novamente</button></small>}</label>}
  {!!tags.length && <fieldset className="tag-picker"><legend>Etiquetas</legend><div>{tags.map(tag => <label key={tag.id}><input type="checkbox" disabled={disabled} checked={tagIds.includes(tag.id)} onChange={event => onTagIdsChange(event.currentTarget.checked ? [...new Set([...tagIds, tag.id])] : tagIds.filter(id => id !== tag.id))}/>{tag.name}</label>)}</div></fieldset>}
  <label>Lembrete (horário de Belém)<input disabled={disabled} type="datetime-local" value={localDateTime(reminderAt)} onChange={event => onReminderChange(isoFromLocal(event.currentTarget.value))}/><small className="muted">Ative as notificações para receber o aviso neste dispositivo.</small></label>
 </>;
}
