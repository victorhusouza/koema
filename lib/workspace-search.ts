import type { Task } from './tasks.ts';
import type { Project } from './task-store.ts';

export type WorkspaceSearchResult =
 | { kind: 'task'; id: number; title: string; done: boolean; context: string }
 | { kind: 'project'; id: number; title: string; completed: boolean; context: string };

export function normalizeSearchText(value: string): string {
 return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
}

export function searchWorkspace(query: string, tasks: Task[], projects: Project[]): WorkspaceSearchResult[] {
 const needle = normalizeSearchText(query);
 if (!needle) return [];
 return [
  ...tasks.filter(task => normalizeSearchText(task.title).includes(needle)).map(task => ({
   kind: 'task' as const,
   id: task.id,
   title: task.title,
   done: task.done,
   context: task.project || (task.plannedDate ? `Planejada para ${task.plannedDate}` : task.when),
  })),
  ...projects.filter(project => normalizeSearchText(project.name).includes(needle)).map(project => ({
   kind: 'project' as const,
   id: project.id,
   title: project.name,
   completed: project.status === 'completed',
   context: project.areaName || 'Sem área',
  })),
 ];
}
