import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWorkspace } from '../lib/workspace-search.ts';
import type { Task } from '../lib/tasks.ts';
import type { Project } from '../lib/task-store.ts';

const tasks = [
 { id: 4, title: 'Revisar a Proposta Comercial', project: 'Trabalho · Proposta comercial', when: 'Hoje', done: true, completed: '2026-10-28T12:00:00Z', notes: '', checklist: [] },
 { id: 9, title: 'Ligar para iPhone suporte', project: '', when: 'Caixa de entrada', done: false, notes: '', checklist: [] },
] as Task[];
const projects = [
 { id: 12, areaId: 3, areaName: 'Trabalho', name: 'Proposta Comercial', status: 'completed' },
] as Project[];

test('search matches task and project titles without case or accent sensitivity', () => {
 const results = searchWorkspace('proposta comercial', tasks, projects);
 assert.deepEqual(results.map(result => [result.kind, result.id]), [['task', 4], ['project', 12]]);
 assert.equal(results[0].kind === 'task' && results[0].done, true);
 assert.equal(results[1].kind === 'project' && results[1].completed, true);
 assert.equal(searchWorkspace('IPHONE', tasks, projects)[0].id, 9);
});

test('empty and unmatched queries return no results', () => {
 assert.deepEqual(searchWorkspace('  ', tasks, projects), []);
 assert.deepEqual(searchWorkspace('inexistente', tasks, projects), []);
});
