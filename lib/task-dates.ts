import type { Task } from './tasks.ts';
export const timeZone = 'America/Belem';
export function localDay(now = new Date()): string { return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now); }
export function addDays(day: string, count: number): string {const date = new Date(day + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate()+count); return date.toISOString().slice(0,10);}
export function validDate(value: unknown): boolean {return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;}
export function isToday(task: Task, today: string): boolean {return !task.done && task.when !== 'Algum dia' && !!task.plannedDate && task.plannedDate <= today;}
export function upcoming(tasks: Task[], today: string): Task[] {return tasks.filter(t=>!t.done && t.when!=='Algum dia' && !!t.plannedDate && t.plannedDate>today).sort((a,b)=>a.plannedDate!.localeCompare(b.plannedDate!) || a.id-b.id);}
export function todayTasks(tasks: Task[], today: string): Task[] {return tasks.filter(t=>isToday(t,today)).sort((a,b)=>(a.position ?? a.id)-(b.position ?? b.id) || a.id-b.id);}
export function dateLabel(day: string, today: string): string { if(day===today) return 'Hoje'; if(day===addDays(today,1)) return 'Amanhã'; return new Intl.DateTimeFormat('pt-BR',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(day+'T12:00:00Z')); }
export function legacyDate(when: string, today: string): string | null {return when==='Hoje' ? today : when==='Amanhã' ? addDays(today,1) : when==='Sex, 30 out' ? '2026-10-30' : when==='Sáb, 31 out' ? '2026-10-31' : null;}
