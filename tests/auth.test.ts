import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeOwner, login, verifySession, revokeSession, resetOwner, SESSION_SLIDING_MS, SESSION_ABSOLUTE_MS } from '../lib/auth.ts';
import { openTaskStore } from '../lib/task-store.ts';
import { testSession } from './auth-fixture.ts';

function fixture() {
 const directory=mkdtempSync(join(tmpdir(),'koema-auth-'));const path=join(directory,'panel.sqlite');const previous=process.env.PAINEL_DB_PATH;process.env.PAINEL_DB_PATH=path;
 return {directory,path,cleanup(){if(previous===undefined)delete process.env.PAINEL_DB_PATH;else process.env.PAINEL_DB_PATH=previous;rmSync(directory,{recursive:true,force:true});}};
}
const request=(cookie?:string)=>new Request('https://koema.example/api/auth/session',{headers:cookie?{Cookie:cookie,Origin:'https://koema.example'}:{Origin:'https://koema.example'}});

test('owner initialization is one-time, concurrent-safe, and passwords verify without storing plaintext',async()=>{
 const f=fixture();try{
  const results=await Promise.allSettled([initializeOwner('Victor','correct horse battery staple'),initializeOwner('Victor','another password entirely')]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  const database=new DatabaseSync(f.path);const owner=database.prepare('SELECT username,password_hash,password_salt FROM koema_owner').get() as {username:string;password_hash:string;password_salt:string};
  assert.equal(owner.username,'Victor');assert.notEqual(owner.password_hash,'correct horse battery staple');assert.notEqual(owner.password_salt,'');database.close();
  const candidates=await Promise.all([
   login(request(),'Victor','correct horse battery staple'),
   login(request(),'Victor','another password entirely'),
  ]);
  assert.equal(candidates.filter(result=>result.ok).length,1);
  assert.equal(candidates.filter(result=>!result.ok).length,1);
  const good=candidates.find(result=>result.ok);
  if(good?.ok){const raw=good.token;const database=new DatabaseSync(f.path);const row=database.prepare('SELECT token_hash FROM koema_sessions').get() as {token_hash:string};assert.equal(row.token_hash,createHash('sha256').update(raw).digest('hex'));assert.notEqual(row.token_hash,raw);database.close();}
 }finally{f.cleanup();}
});

test('login rate limit is persistent, generic for bad credentials, and bounds its table',async()=>{
 const f=fixture();try{
  await initializeOwner('owner','a sufficiently long passphrase');
  for(let i=0;i<5;i++){const result=await login(request(),i%2?'absent':'owner','incorrect password');assert.deepEqual(result,{ok:false,limited:false});}
  assert.deepEqual(await login(request(),'owner','incorrect password'),{ok:false,limited:true});
  const database=new DatabaseSync(f.path);assert.equal((database.prepare('SELECT COUNT(*) AS n FROM koema_login_attempts').get() as {n:number}).n,1);database.close();
 }finally{f.cleanup();}
});

test('sessions slide to seven days, stop at thirty days, and logout revokes the server record',async()=>{
 const f=fixture();try{
  await initializeOwner('owner','a sufficiently long passphrase');
  const result=await login(request(),'owner','a sufficiently long passphrase');assert.equal(result.ok,true);if(!result.ok)return;
  const cookie=`koema_session=${result.token}`;assert.equal((await verifySession(request(cookie)))?.username,'owner');
  let database=new DatabaseSync(f.path);let row=database.prepare('SELECT token_hash,created_at,expires_at,absolute_expires_at FROM koema_sessions').get() as {token_hash:string;created_at:number;expires_at:number;absolute_expires_at:number};
  assert.equal(row.expires_at-row.created_at,SESSION_SLIDING_MS);
  assert.equal(row.absolute_expires_at-row.created_at,SESSION_ABSOLUTE_MS);
  database.prepare('UPDATE koema_sessions SET last_seen_at=?,expires_at=?').run(Date.now()-120000,Date.now()+1000);database.close();
  const refreshed=await verifySession(request(cookie));assert.ok(refreshed);assert.ok(refreshed!.maxAge>6*86400000);
  database=new DatabaseSync(f.path);database.prepare('UPDATE koema_sessions SET absolute_expires_at=?').run(Date.now()-1);database.close();
  assert.equal(await verifySession(request(cookie)),null);
  const fresh=await login(request(),'owner','a sufficiently long passphrase');assert.equal(fresh.ok,true);if(fresh.ok)revokeSession(request(`koema_session=${fresh.token}`));
  assert.equal(await verifySession(request(`koema_session=${fresh.ok?fresh.token:''}`)),null);
  assert.ok(row.token_hash);
 }finally{f.cleanup();}
});

test('owner recovery rotates the password and revokes every existing session', async () => {
 const f=fixture();
 try {
  await initializeOwner('owner','a sufficiently long passphrase');
  const session=await login(request(),'owner','a sufficiently long passphrase');
  assert.equal(session.ok,true);
  if(!session.ok)return;
  await resetOwner('owner','a different long passphrase');
  assert.equal(await verifySession(request(`koema_session=${session.token}`)),null);
  assert.equal((await login(request(),'owner','a sufficiently long passphrase')).ok,false);
  assert.equal((await login(request(),'owner','a different long passphrase')).ok,true);
 } finally {f.cleanup();}
});

test('login endpoint sets a secure opaque cookie and rejects oversized streamed bodies', async () => {
 const f=fixture();
 const previousOrigin=process.env.KOEMA_PUBLIC_ORIGIN;
 process.env.KOEMA_PUBLIC_ORIGIN='https://koema.example';
 try {
  await initializeOwner('owner','a sufficiently long passphrase');
  const { POST }=await import('../app/api/auth/login/route.ts');
  const response=await POST(new Request('https://koema.example/api/auth/login',{
   method:'POST',
   headers:{origin:'https://koema.example','content-type':'application/json'},
   body:JSON.stringify({username:'owner',password:'a sufficiently long passphrase'}),
  }));
  assert.equal(response.status,200);
  assert.match(response.headers.get('set-cookie')||'',/^koema_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/);
  const oversizedBody=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(4097));}});
  const oversized=await POST(new Request('https://koema.example/api/auth/login',{
   method:'POST',
   headers:{origin:'https://koema.example','content-type':'application/json'},
   body:oversizedBody,
   duplex:'half',
  } as RequestInit & {duplex:'half'}));
  assert.equal(oversized.status,413);
 } finally {
  if(previousOrigin===undefined)delete process.env.KOEMA_PUBLIC_ORIGIN;else process.env.KOEMA_PUBLIC_ORIGIN=previousOrigin;
  f.cleanup();
 }
});

test('every data API boundary rejects missing sessions and an authenticated data read succeeds',async()=>{
 const f=fixture();try{
  const walk=(directory:string):string[]=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(join(directory,entry.name)):[join(directory,entry.name)]);
  const routeFiles=walk(join(process.cwd(),'app/api')).filter(path=>path.endsWith('route.ts'));
  for(const path of routeFiles){const source=readFileSync(path,'utf8');if(path.includes('/api/auth/')){if(path.endsWith('/login/route.ts')||path.endsWith('/logout/route.ts'))assert.match(source,/validateMutationOrigin/);continue;}assert.match(source,/requireSession\(request\)/,`${path} must verify a server-side session`);}
  openTaskStore(f.path).close();
  const route=await import('../app/api/calendar-feed/route.ts');
  assert.equal((await route.GET(new Request('http://localhost/api/calendar-feed'))).status,401);
  const session=testSession(f.path);const response=await route.GET(new Request('http://localhost/api/calendar-feed',{headers:session.headers}));assert.equal(response.status,200);
 }finally{f.cleanup();}
});
