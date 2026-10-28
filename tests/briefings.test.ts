import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openBriefStore } from '../lib/brief-store.ts';
import { BriefingInputError, initialBrief } from '../lib/briefing.ts';
import { openTaskStore } from '../lib/task-store.ts';

test('briefings save by date, retain history, and persist across a new process', () => {
 const directory = mkdtempSync(join(tmpdir(), 'painel-briefings-'));
 const path = join(directory, 'test.sqlite');
 try {
  const tasks = openTaskStore(path);
  const task = tasks.create({ title: 'tarefa de controle' });
  const taskSnapshot = tasks.list();
  tasks.close();

  let store = openBriefStore(path);
  assert.equal(store.get('2026-10-26'), undefined);
  assert.deepEqual(store.get('2026-10-27'), initialBrief);
  const originalSeed = store.get('2026-10-27')!;
  const first = store.save('2026-10-28', { Hoje: 'Primeiro texto', Pendências: 'Em aberto', Semana: 'Planejamento' });
  assert.equal(first.Hoje, 'Primeiro texto');
  store.save('2026-10-28', { Hoje: 'Texto atualizado', Pendências: 'Resolvido', Semana: 'Revisada' });
  store.save('2026-10-29', { Hoje: 'Outro dia', Pendências: 'Nada', Semana: 'Próxima' });

  assert.deepEqual(store.list().map(row => row.date), ['2026-10-29', '2026-10-28', '2026-10-27']);
  assert.equal(store.get('2026-10-28')?.Hoje, 'Texto atualizado');
  store.save('2026-10-27', { Hoje: 'Briefing inicial editado', Pendências: originalSeed.Pendências, Semana: originalSeed.Semana });
  assert.equal(store.get('2026-10-27')?.Hoje, 'Briefing inicial editado');
  store.close();

  const script = `import {openBriefStore} from ${JSON.stringify(new URL('../lib/brief-store.ts', import.meta.url).href)}; const s=openBriefStore(${JSON.stringify(path)}); process.stdout.write(JSON.stringify({list:s.list(), brief:s.get('2026-10-28'), seed:s.get('2026-10-27')})); s.close();`;
  const reopened = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' }));
  assert.deepEqual(reopened.list.map((row: { date: string }) => row.date), ['2026-10-29', '2026-10-28', '2026-10-27']);
  assert.equal(reopened.brief.Hoje, 'Texto atualizado');
  assert.equal(reopened.brief.Pendências, 'Resolvido');
  assert.equal(reopened.seed.Hoje, 'Briefing inicial editado');

  store = openBriefStore(path);
  assert.equal(store.get('2026-02-30'), undefined);
  store.close();
  const taskStore = openTaskStore(path);
  assert.deepEqual(taskStore.list(), taskSnapshot);
  assert.ok(taskStore.list().some(row => row.id === task.id));
  taskStore.close();
 } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid briefing data is rejected without losing the saved version', () => {
 const directory = mkdtempSync(join(tmpdir(), 'painel-brief-validation-'));
 const path = join(directory, 'test.sqlite');
 const store = openBriefStore(path);
 try {
  const saved = store.save('2026-10-28', { Hoje: 'Versão confirmada', Pendências: 'Pendente', Semana: 'Plano' });
  assert.throws(() => store.save('2026-02-30', { Hoje: 'Inválido', Pendências: '', Semana: '' }), TypeError);
  assert.throws(() => store.save('2026-10-28', { Hoje: 'Tentativa', Pendências: '', Semana: '', extra: 'campo' } as never), BriefingInputError);
  assert.throws(() => store.save('2026-10-28', { Hoje: 'x'.repeat(20001), Pendências: '', Semana: '' }), BriefingInputError);
  assert.deepEqual(store.get('2026-10-28'), saved);
 } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
