import test from 'node:test';
import assert from 'node:assert/strict';
import { canApplyBriefingLoad } from '../lib/briefing-load-guard.ts';

test('a deferred initial briefing response cannot replace edits made while it was pending', async () => {
 let resolve!: (value: { Hoje: string }) => void;
 const pending = new Promise<{ Hoje: string }>(done => { resolve = done; });
 const state = { content: { Hoje: 'Rascunho novo' }, version: 1, requestId: 1 };
 const response = pending.then(body => {
  if (canApplyBriefingLoad({ requestId: 1, currentRequestId: state.requestId, loadedVersion: 0, currentVersion: state.version })) {
   state.content = body;
  }
 });
 resolve({ Hoje: 'Conteúdo antigo do servidor' });
 await response;
 assert.equal(state.content.Hoje, 'Rascunho novo');
});

test('only the latest requested date can apply its response', () => {
 assert.equal(canApplyBriefingLoad({ requestId: 1, currentRequestId: 2, loadedVersion: 0, currentVersion: 0 }), false);
 assert.equal(canApplyBriefingLoad({ requestId: 2, currentRequestId: 2, loadedVersion: 0, currentVersion: 0 }), true);
});
