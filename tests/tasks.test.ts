import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openTaskStore, TaskInputError } from '../lib/task-store.ts';

test('task lifecycle survives a new process and never reseeds deleted data', () => {
 const directory = mkdtempSync(join(tmpdir(),'painel-tasks-'));
 const path = join(directory,'test.sqlite');
 try {
  let store = openTaskStore(path);
  const task = store.create({title:'mandar teste',when:'Hoje'});
  assert.equal(task.title,'Mandar teste');
  store.update(task.id,{notes:'iPhone e eBay',checklist:[{text:'conferir',done:true}]});
  const done = store.update(task.id,{done:true})!;
  assert.ok(done.completed && !Number.isNaN(Date.parse(done.completed)));
  const timestamp = done.completed;
  assert.equal(store.update(task.id,{done:true})!.completed,timestamp);
  store.close();
  const script = `import {openTaskStore} from ${JSON.stringify(new URL('../lib/task-store.ts',import.meta.url).href)}; const s=openTaskStore(${JSON.stringify(path)}); process.stdout.write(JSON.stringify(s.list())); s.close();`;
  const rows = JSON.parse(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{encoding:'utf8'}));
  const saved = rows.find((row:{id:number}) => row.id===task.id);
  assert.equal(saved.title,'Mandar teste'); assert.equal(saved.done,true);
  assert.equal(saved.notes,'iPhone e eBay'); assert.equal(saved.checklist[0].text,'Conferir');
  store=openTaskStore(path);
  assert.equal(store.update(task.id,{done:false})!.completed,undefined);
  for (const row of store.list()) store.remove(row.id);
  store.close(); store=openTaskStore(path);
  assert.deepEqual(store.list(),[]); store.close();
 } finally {rmSync(directory,{recursive:true,force:true});}
});

test('invalid changes do not overwrite a confirmed task; field patches preserve other fields',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-validation-'));
 const store=openTaskStore(join(directory,'test.sqlite'));
 try {
  const task=store.create({title:'eBay pesquisa'});
  assert.equal(task.title,'eBay pesquisa');
  assert.throws(()=>store.update(task.id,{title:' '}),TaskInputError);
  assert.throws(()=>store.update(task.id,{done:'sim'}),TaskInputError);
  store.update(task.id,{notes:'anotação'}); store.update(task.id,{done:true});
  const saved=store.list().find(t=>t.id===task.id)!;
  assert.equal(saved.title,'eBay pesquisa'); assert.equal(saved.notes,'Anotação');
  assert.equal(store.update(999999,{title:'Ausente'}),undefined);
 } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('areas and projects keep stable task links through renames and project completion',()=>{
 const directory=mkdtempSync(join(tmpdir(),'painel-organization-'));const path=join(directory,'test.sqlite');
 try{
  let store=openTaskStore(path);
  const legacy=store.list().find(task=>task.title==='Preparar a proposta do novo projeto')!;
  assert.equal(legacy.areaName,'Trabalho');assert.equal(legacy.projectName,'Proposta comercial');
  const area=store.createArea({name:'saúde'});const project=store.createProject({name:'dentista',areaId:area.id});
  const task=store.create({title:'marcar consulta',when:'Hoje',areaId:area.id,projectId:project.id});
  assert.equal(task.areaId,area.id);assert.equal(task.projectId,project.id);assert.equal(task.project,'Saúde · Dentista');
  assert.throws(()=>store.setProjectStatus(project.id,'completed'),TaskInputError);
  store.updateArea(area.id,{name:'Bem-estar'});store.updateProject(project.id,{name:'Consulta anual',areaId:area.id});
  assert.equal(store.list().find(item=>item.id===task.id)?.project,'Bem-estar · Consulta anual');
  store.update(task.id,{done:true});assert.equal(store.setProjectStatus(project.id,'completed')?.status,'completed');
  assert.equal(store.setProjectStatus(project.id,'open')?.status,'open');
  store.update(task.id,{done:false});store.update(task.id,{areaId:null,projectId:null});
  const someday=store.create({title:'ideia sem prazo',when:'Algum dia'});store.close();
  store=openTaskStore(path);
  assert.equal(store.list().find(item=>item.id===task.id)?.areaId,null);
  assert.equal(store.list().find(item=>item.id===someday.id)?.when,'Algum dia');
  store.close();
 }finally{rmSync(directory,{recursive:true,force:true});}
});
