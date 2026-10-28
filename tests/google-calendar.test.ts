import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { accessToken, dayBounds, GOOGLE_SCOPE, googleConfig, listGoogleEvents, makeState, normalizeEvent, openGoogleStore, originAllowed, stateMatches } from '../lib/google-calendar.ts';
import { GET as googleCallback } from '../app/api/google/callback/route.ts';
import { GET as googleConnect } from '../app/api/google/connect/route.ts';
import { POST as googleDisconnect } from '../app/api/google/disconnect/route.ts';

function fixture() {
 const dir = mkdtempSync(join(tmpdir(), 'painel-google-'));
 const config = { clientId:'mock-client',clientSecret:'mock-secret',redirectUri:'http://127.0.0.1:3000/api/google/callback',dbPath:join(dir,'panel.sqlite'),encryptionKey:Buffer.alloc(32,3).toString('base64') };
 const store = openGoogleStore(config); return { dir, config, store, close() { store.close(); rmSync(dir,{recursive:true,force:true}); } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status,headers:{'Content-Type':'application/json'}});

test('configuration does not expose credentials and validates the fixed callback', () => {
 assert.equal(googleConfig({}),null);
 assert.equal(googleConfig({ GOOGLE_CLIENT_ID:'id',GOOGLE_CLIENT_SECRET:'secret',GOOGLE_REDIRECT_URI:'http://127.0.0.1:3000/api/google/callback' })?.redirectUri,'http://127.0.0.1:3000/api/google/callback');
 assert.equal(googleConfig({ GOOGLE_CLIENT_ID:'id',GOOGLE_CLIENT_SECRET:'secret',GOOGLE_REDIRECT_URI:'javascript:alert(1)' }),null);
});

test('state is random, bound to cookie and rejected when missing, mismatched, or expired', () => {
 const now = 1_700_000_000_000; const state = makeState(now); assert.equal(state.value.length,64); assert.ok(stateMatches(state.value,state.value,state.expires,now+1));
 assert.equal(stateMatches(null,state.value,state.expires,now+1),false); assert.equal(stateMatches('a'.repeat(64),state.value,state.expires,now+1),false); assert.equal(stateMatches(state.value,state.value,state.expires,now+600_001),false);
});

test('OAuth denial with a valid state returns to the panel as cancelled without saving a connection', async () => {
 const env = { GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET:process.env.GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI:process.env.GOOGLE_REDIRECT_URI };
 const now = Date.now(); const state = makeState(now);
 process.env.GOOGLE_CLIENT_ID='mock-client'; process.env.GOOGLE_CLIENT_SECRET='mock-secret'; process.env.GOOGLE_REDIRECT_URI='http://127.0.0.1:3000/api/google/callback';
 try {
  const req = new Request(`http://127.0.0.1:3000/api/google/callback?error=access_denied&state=${state.value}`,{headers:{cookie:`painel_google_oauth_state=${state.value}; painel_google_oauth_state_expires=${state.expires}`}});
  const response = await googleCallback(req); assert.equal(new URL(response.headers.get('location')!).searchParams.get('google_calendar'),'cancelled'); assert.match(response.headers.get('set-cookie') || '',/Max-Age=0/);
  const invalid = await googleCallback(new Request(`http://127.0.0.1:3000/api/google/callback?error=access_denied&state=${state.value}`)); assert.equal(new URL(invalid.headers.get('location')!).searchParams.get('google_calendar'),'error');
 } finally {
  for (const [key,value] of Object.entries({GOOGLE_CLIENT_ID:env.GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET:env.GOOGLE_CLIENT_SECRET,GOOGLE_REDIRECT_URI:env.GOOGLE_REDIRECT_URI})) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
 }
});

test('OAuth connect and callback routes set state cookies and persist only after a valid callback', async () => {
 const dir=mkdtempSync(join(tmpdir(),'painel-google-routes-'));
 const keys=['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI','GOOGLE_TOKEN_ENCRYPTION_KEY','PAINEL_DB_PATH'] as const;
 const env=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 process.env.GOOGLE_CLIENT_ID='mock-client'; process.env.GOOGLE_CLIENT_SECRET='mock-secret'; process.env.GOOGLE_REDIRECT_URI='http://127.0.0.1:3000/api/google/callback'; process.env.GOOGLE_TOKEN_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64'); process.env.PAINEL_DB_PATH=join(dir,'panel.sqlite');
 const originalFetch=globalThis.fetch;
 try {
  const start=await googleConnect(new Request('http://127.0.0.1:3000/api/google/connect'));
  assert.equal(start.status,302); const auth=new URL(start.headers.get('location')!); assert.equal(auth.origin,'https://accounts.google.com'); assert.equal(auth.searchParams.get('scope'),GOOGLE_SCOPE);
  const cookies=start.headers.getSetCookie(); assert.equal(cookies.length,2); assert.match(cookies[0],/HttpOnly; SameSite=Lax/); const state=cookies[0].match(/painel_google_oauth_state=([a-f0-9]{64})/)![1]; const expires=cookies[1].match(/state_expires=(\d+)/)![1];
  globalThis.fetch=async () => json({access_token:'access-new',refresh_token:'refresh-new',expires_in:3600,scope:GOOGLE_SCOPE});
  const response=await googleCallback(new Request(`http://127.0.0.1:3000/api/google/callback?code=mock-code&state=${state}`,{headers:{cookie:`painel_google_oauth_state=${state}; painel_google_oauth_state_expires=${expires}`}}));
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('google_calendar'),'connected'); assert.equal(response.headers.getSetCookie().length,2);
  const store=openGoogleStore({clientId:'mock-client',clientSecret:'mock-secret',redirectUri:'http://127.0.0.1:3000/api/google/callback',dbPath:join(dir,'panel.sqlite'),encryptionKey:Buffer.alloc(32,7).toString('base64')});
  try { assert.equal(store.read()?.refreshToken,'refresh-new'); } finally { store.close(); }
 } finally {
  globalThis.fetch=originalFetch; rmSync(dir,{recursive:true,force:true});
  for (const key of keys) { const value=env[key]; if(value===undefined) delete process.env[key]; else process.env[key]=value; }
 }
});

test('local token storage encrypts tokens and reads them using the same key', () => {
 const f = fixture(); try { f.store.save({accessToken:'private-access',refreshToken:'private-refresh',expiresAt:Date.now()+50000,scope:GOOGLE_SCOPE}); const raw = f.store.raw(); assert.ok(raw); assert.equal(raw.includes('private-access'),false); assert.equal(raw.includes('private-refresh'),false); assert.equal(f.store.read()?.refreshToken,'private-refresh'); } finally { f.close(); }
});

test('concurrent first writes keep one stable 0600 key and tokens remain readable after reopen', async () => {
 const dir=mkdtempSync(join(tmpdir(),'painel-google-key-race-')); const dbPath=join(dir,'panel.sqlite'); const keyPath=join(dir,'google.key');
 const moduleUrl=new URL('../lib/google-calendar.ts',import.meta.url).href; const config={clientId:'id',clientSecret:'secret',redirectUri:'http://127.0.0.1:3000/api/google/callback',dbPath,keyPath};
 const child=`import {openGoogleStore} from ${JSON.stringify(moduleUrl)}; const s=openGoogleStore(${JSON.stringify(config)}); s.save({accessToken:'a',refreshToken:'r',expiresAt:9999999999999,scope:${JSON.stringify(GOOGLE_SCOPE)}}); s.close();`;
 const run=()=>new Promise<void>((resolve,reject)=>{const proc=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',child],{stdio:'ignore'});proc.once('error',reject);proc.once('exit',code=>code===0?resolve():reject(new Error('key writer failed')));});
 try {
  await Promise.all([run(),run()]); const store=openGoogleStore(config); try {assert.equal(store.read()?.refreshToken,'r');assert.equal(statSync(keyPath).mode & 0o777,0o600);}finally{store.close();}
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('expired access token is refreshed and saved; invalid_grant removes the connection', async () => {
 const f = fixture(); try {
  f.store.save({accessToken:'old',refreshToken:'refresh',expiresAt:0,scope:GOOGLE_SCOPE});
  const refreshed = await accessToken(f.config,f.store,async (_input,init) => { assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'),'refresh_token'); return json({access_token:'new',expires_in:3600}); });
  assert.equal(refreshed,'new'); assert.equal(f.store.read()?.refreshToken,'refresh');
  f.store.save({accessToken:'old',refreshToken:'refresh',expiresAt:0,scope:GOOGLE_SCOPE});
  await assert.rejects(accessToken(f.config,f.store,async () => json({error:'invalid_grant'},400)),/expirou/);
  assert.equal(f.store.hasTokens(),false);
 } finally { f.close(); }
});

test('Belem day bounds cover the local UTC-3 civil day', () => {
 assert.deepEqual(dayBounds('2026-10-28'),{timeMin:'2026-10-28T00:00:00-03:00',timeMax:'2026-10-29T00:00:00-03:00'});
 assert.throws(() => dayBounds('2026-02-30'));
});

test('all-day, untitled and overnight events normalize without unsafe links', () => {
 assert.deepEqual(normalizeEvent({id:'all',start:{date:'2026-10-28'},end:{date:'2026-10-29'}}),{id:'all',title:'Evento sem título',date:'2026-10-28',time:null,endTime:null,allDay:true,meetingUrl:null});
 assert.deepEqual(normalizeEvent({id:'night',start:{dateTime:'2026-10-29T01:30:00Z'},end:{dateTime:'2026-10-29T09:30:00Z'},hangoutLink:'http://unsafe.test'}),{id:'night',title:'Evento sem título',date:'2026-10-28',time:'22:30',endTime:null,allDay:false,meetingUrl:null});
 assert.equal(normalizeEvent({id:'ok',start:{dateTime:'2026-10-28T15:00:00-03:00'},end:{dateTime:'2026-10-28T16:00:00-03:00'},conferenceData:{entryPoints:[{entryPointType:'video',uri:'https://meet.google.com/abc'}]}})?.meetingUrl,'https://meet.google.com/abc');
});

test('event listing expands recurring instances, pages all results, and reports provider failure', async () => {
 const f = fixture(); try {
  f.store.save({accessToken:'fresh',refreshToken:'refresh',expiresAt:Date.now()+600000,scope:GOOGLE_SCOPE}); let calls=0;
  const events = await listGoogleEvents(f.config,f.store,'2026-10-28',async (input,init) => {
   const url = new URL(String(input)); assert.equal(url.searchParams.get('singleEvents'),'true'); assert.equal(url.searchParams.get('orderBy'),'startTime'); assert.equal(url.searchParams.get('timeMin'),'2026-10-28T00:00:00-03:00'); assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer fresh'); calls++;
   return calls===1 ? json({items:[{id:'1',summary:'Reunião',start:{dateTime:'2026-10-28T14:00:00-03:00'},end:{dateTime:'2026-10-28T15:00:00-03:00'}}],nextPageToken:'next'}) : json({items:[{id:'2',start:{date:'2026-10-28'},end:{date:'2026-10-29'}}]});
  });
  assert.equal(calls,2); assert.equal(events.length,2); assert.equal(events[0].time,'14:00'); assert.equal(events[1].allDay,true);
  await assert.rejects(listGoogleEvents(f.config,f.store,'2026-10-28',async () => json({error:{status:'UNAVAILABLE'}},503)),/atualizar/);
 } finally { f.close(); }
});

test('disconnect mutation accepts only the configured local origin', () => {
 const f=fixture(); try { assert.equal(originAllowed(new Request('http://127.0.0.1:3000/api/google/disconnect',{headers:{origin:'http://127.0.0.1:3000'}}),f.config),true); assert.equal(originAllowed(new Request('http://127.0.0.1:3000/api/google/disconnect',{headers:{origin:'https://other.example'}}),f.config),false); assert.equal(originAllowed(new Request('http://127.0.0.1:3000/api/google/disconnect'),f.config),false); } finally { f.close(); }
});

test('disconnect revokes remotely when possible and always removes local tokens', async () => {
 const dir=mkdtempSync(join(tmpdir(),'painel-google-disconnect-')); const keys=['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI','GOOGLE_TOKEN_ENCRYPTION_KEY','PAINEL_DB_PATH'] as const; const env=Object.fromEntries(keys.map(key=>[key,process.env[key]])); const originalFetch=globalThis.fetch;
 process.env.GOOGLE_CLIENT_ID='mock-client';process.env.GOOGLE_CLIENT_SECRET='mock-secret';process.env.GOOGLE_REDIRECT_URI='http://127.0.0.1:3000/api/google/callback';process.env.GOOGLE_TOKEN_ENCRYPTION_KEY=Buffer.alloc(32,8).toString('base64');process.env.PAINEL_DB_PATH=join(dir,'panel.sqlite');
 try {
  const config=googleConfig()!; const store=openGoogleStore(config);store.save({accessToken:'a',refreshToken:'r',expiresAt:Date.now()+50000,scope:GOOGLE_SCOPE});store.close();
  globalThis.fetch=async (_input,init)=>{assert.equal(new URLSearchParams(String(init?.body)).get('token'),'r');return new Response(null,{status:200});};
  const response=await googleDisconnect(new Request('http://127.0.0.1:3000/api/google/disconnect',{method:'POST',headers:{origin:'http://127.0.0.1:3000'}})); const result=await response.json(); assert.equal(result.revoked,true); assert.equal(result.connected,false);
  const check=openGoogleStore(config);try{assert.equal(check.hasTokens(),false);}finally{check.close();}
 } finally {globalThis.fetch=originalFetch;rmSync(dir,{recursive:true,force:true});for(const key of keys){const value=env[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
