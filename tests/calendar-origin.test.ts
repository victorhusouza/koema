import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../app/api/calendar-feed/route.ts';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testSession } from './auth-fixture.ts';

const directory=mkdtempSync(join(tmpdir(),'koema-origin-'));const previous=process.env.PAINEL_DB_PATH;process.env.PAINEL_DB_PATH=join(directory,'panel.sqlite');const session=testSession(process.env.PAINEL_DB_PATH);const auth={Cookie:`koema_session=${session.token}`};
test.after(()=>{if(previous===undefined)delete process.env.PAINEL_DB_PATH;else process.env.PAINEL_DB_PATH=previous;rmSync(directory,{recursive:true,force:true});});

test('accepts browser origin matching Host when Next uses localhost internally', async () => {
 const response = await POST(new Request('http://localhost:3000/api/calendar-feed', {method:'POST', headers:{...auth,Host:'127.0.0.1:3000',Origin:'http://127.0.0.1:3000','Content-Type':'application/json'},body:JSON.stringify({url:'invalid-fixture'})}));
 assert.equal(response.status,400);
 assert.match((await response.json()).error,/iCal/);
});

test('rejects external origins and mismatched ports or protocols', async () => {
 for (const origin of ['https://evil.example','http://127.0.0.1:4000','https://127.0.0.1:3000','null']) {
  const response = await POST(new Request('http://localhost:3000/api/calendar-feed',{method:'POST',headers:{...auth,Host:'127.0.0.1:3000',Origin:origin},body:'{}'}));
  assert.equal(response.status,403);
 }
});
