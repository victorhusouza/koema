'use client';
import { ArrowDown, ArrowUp, Folder, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Area, Heading, Project, Tag } from '../lib/task-store';

type OrganizationPanelProps = {
 areas: Area[];
 projects: Project[];
 tags: Tag[];
 openTaskCount: (scope: { areaId?: number; projectId?: number }) => number;
 onCreateArea: () => void;
 onRenameArea: (area: Area) => void;
 onCreateProject: (areaId?: number) => void;
 onEditProject: (project: Project) => void;
 onSetProjectStatus: (project: Project) => void;
 onChanged: () => void;
};

async function api(path:string,method='GET',body?:unknown){const response=await fetch(path,{method,cache:'no-store',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.error||'Não foi possível salvar.');return value;}

export default function OrganizationPanel({ areas, projects, tags, openTaskCount, onCreateArea, onRenameArea, onCreateProject, onEditProject, onSetProjectStatus, onChanged }: OrganizationPanelProps) {
 const [headings,setHeadings]=useState<Record<number,Heading[]>>({});
 const [headingInputs,setHeadingInputs]=useState<Record<number,string>>({});
 const [headingError,setHeadingError]=useState('');
 const [headingEditId,setHeadingEditId]=useState<number|null>(null);
 const [headingEditTitle,setHeadingEditTitle]=useState('');
 const [tagName,setTagName]=useState('');const [tagParent,setTagParent]=useState('');const [tagShortcut,setTagShortcut]=useState('');const [editingTagId,setEditingTagId]=useState<number|null>(null);const [tagError,setTagError]=useState('');const [saving,setSaving]=useState(false);
 async function loadHeadings(projectId:number){setHeadingError('');try{const values=await api(`/api/headings?projectId=${projectId}`);setHeadings(current=>({...current,[projectId]:values}));}catch(error){setHeadingError(error instanceof Error?error.message:'Não foi possível carregar as seções.');}}
 useEffect(()=>{void Promise.all(projects.map(project=>loadHeadings(project.id)));},[projects]);
 async function addHeading(projectId:number){if(saving)return;setSaving(true);setHeadingError('');try{const value=await api('/api/headings','POST',{projectId,title:headingInputs[projectId]??''});setHeadings(current=>({...current,[projectId]:[...(current[projectId]??[]),value]}));setHeadingInputs(current=>({...current,[projectId]:''}));}catch(error){setHeadingError(error instanceof Error?error.message:'Não foi possível criar a seção.');}finally{setSaving(false);}}
 async function renameHeading(heading:Heading){try{const value=await api(`/api/headings/${heading.id}`,'PATCH',{title:headingEditTitle});setHeadings(current=>({...current,[heading.projectId]:(current[heading.projectId]??[]).map(item=>item.id===value.id?value:item)}));setHeadingEditId(null);setHeadingEditTitle('');setHeadingError('');}catch(error){setHeadingError(error instanceof Error?error.message:'Não foi possível renomear a seção.');}}
 async function deleteHeading(heading:Heading){if(!window.confirm('Excluir esta seção? As tarefas continuarão no projeto.'))return;try{await api(`/api/headings/${heading.id}`,'DELETE');setHeadings(current=>({...current,[heading.projectId]:(current[heading.projectId]??[]).filter(item=>item.id!==heading.id)}));onChanged();}catch(error){setHeadingError(error instanceof Error?error.message:'Não foi possível excluir a seção.');}}
 async function moveHeading(projectId:number,index:number,delta:number){const current=headings[projectId]??[];const target=index+delta;if(target<0||target>=current.length)return;const next=[...current];[next[index],next[target]]=[next[target],next[index]];setHeadings(value=>({...value,[projectId]:next}));try{const saved=await api(`/api/headings/order?projectId=${projectId}`,'PUT',next.map(item=>item.id));setHeadings(value=>({...value,[projectId]:saved}));setHeadingError('');}catch(error){setHeadings(value=>({...value,[projectId]:current}));setHeadingError(error instanceof Error?error.message:'Não foi possível ordenar as seções.');}}
 async function saveTag(event:React.FormEvent){event.preventDefault();if(saving)return;setSaving(true);setTagError('');try{const value={name:tagName,parentId:tagParent?Number(tagParent):null,shortcut:tagShortcut||null};await api(editingTagId===null?'/api/tags':`/api/tags/${editingTagId}`,editingTagId===null?'POST':'PATCH',value);setTagName('');setTagParent('');setTagShortcut('');setEditingTagId(null);onChanged();}catch(error){setTagError(error instanceof Error?error.message:'Não foi possível salvar a etiqueta.');}finally{setSaving(false);}}
 function editTag(tag:Tag){setTagName(tag.name);setTagParent(tag.parentId===null?'':String(tag.parentId));setTagShortcut(tag.shortcut??'');setEditingTagId(tag.id);setTagError('');}
 async function deleteTag(tag:Tag){if(!window.confirm(`Excluir a etiqueta “${tag.name}”?`))return;try{await api(`/api/tags/${tag.id}`,'DELETE');onChanged();}catch(error){setTagError(error instanceof Error?error.message:'Não foi possível excluir a etiqueta.');}}
 const sortedTags=[...tags].sort((a,b)=>(a.parentId===null?0:1)-(b.parentId===null?0:1)||a.name.localeCompare(b.name,'pt-BR'));
 return <section className="card list-view organization-panel">
  <div className="section-top"><h2>Áreas</h2><button className="text-button" onClick={onCreateArea}><Plus size={16}/> Nova área</button></div>
  {areas.length === 0 && <p className="empty">Crie uma área para reunir responsabilidades e projetos.</p>}
  {areas.map(area => <div className="organization-row" key={area.id}>
   <div><strong>{area.name}</strong><small>{openTaskCount({ areaId: area.id })} tarefas abertas</small></div>
   <button className="text-button" onClick={() => onRenameArea(area)}>Renomear</button>
   <button className="text-button" onClick={() => onCreateProject(area.id)}><Plus size={15}/> Projeto</button>
  </div>)}
  <div className="section-top organization-heading"><h2>Projetos</h2><button className="text-button" onClick={() => onCreateProject()}><Plus size={16}/> Novo projeto</button></div>
  {headingError&&<p className="save-error heading-error" role="alert">{headingError} <button className="text-button" onClick={()=>projects.forEach(project=>void loadHeadings(project.id))}>Tentar novamente</button></p>}
  {projects.length === 0 && <p className="empty">Ainda não há projetos.</p>}
  {projects.map(project => {
   const openCount = openTaskCount({ projectId: project.id });
   return <div className="organization-row" key={project.id}>
    <div><strong><Folder size={14}/> {project.name}</strong><small>{project.areaName??'Sem área'} · {project.status === 'completed' ? 'Concluído' : 'Em andamento'} · {openCount} tarefas abertas</small>{(project.plannedDate||project.deadline)&&<small>{project.plannedDate&&`Planejado: ${new Intl.DateTimeFormat('pt-BR',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(`${project.plannedDate}T12:00:00Z`))}`}{project.plannedDate&&project.deadline?' · ':''}{project.deadline&&`Prazo: ${new Intl.DateTimeFormat('pt-BR',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(`${project.deadline}T12:00:00Z`))}`}</small>}{project.notes&&<details className="project-notes-preview"><summary>Notas do projeto</summary><p>{project.notes}</p></details>}<div className="heading-manager">{(headings[project.id]??[]).map((heading,index)=><div className="heading-manager-row" key={heading.id}>{headingEditId===heading.id?<><input autoFocus aria-label="Nome da seção" maxLength={200} value={headingEditTitle} onChange={event=>setHeadingEditTitle(event.currentTarget.value)}/><button className="text-button" onClick={()=>void renameHeading(heading)}>Salvar</button><button className="text-button" onClick={()=>{setHeadingEditId(null);setHeadingEditTitle('');}}>Cancelar</button></>:<><span>{heading.title||'Sem título'}</span><button className="icon-button" aria-label="Mover seção para cima" disabled={index===0} onClick={()=>void moveHeading(project.id,index,-1)}><ArrowUp size={13}/></button><button className="icon-button" aria-label="Mover seção para baixo" disabled={index===(headings[project.id]?.length??1)-1} onClick={()=>void moveHeading(project.id,index,1)}><ArrowDown size={13}/></button><button className="text-button" onClick={()=>{setHeadingEditId(heading.id);setHeadingEditTitle(heading.title);setHeadingError('');}}>Renomear</button><button className="icon-button" aria-label="Excluir seção" onClick={()=>void deleteHeading(heading)}><Trash2 size={13}/></button></>}</div>)}<div className="heading-add"><input aria-label={`Nova seção em ${project.name}`} placeholder="Nova seção" maxLength={200} value={headingInputs[project.id]??''} onChange={event=>{const value=event.currentTarget.value;setHeadingInputs(current=>({...current,[project.id]:value}));}}/><button className="text-button" onClick={()=>void addHeading(project.id)}><Plus size={14}/> Adicionar</button></div></div></div>
    <button className="text-button" onClick={() => onEditProject(project)}>Editar</button>
    <button className="text-button" onClick={() => onSetProjectStatus(project)}>{project.status === 'open' ? 'Concluir' : 'Reabrir'}</button>
   </div>;
  })}
  <div className="section-top organization-heading"><h2>Etiquetas</h2></div>
  <div className="tag-management"><form onSubmit={saveTag} className="tag-create"><label>{editingTagId===null?'Nova etiqueta':'Editar etiqueta'}<input maxLength={80} value={tagName} onChange={event=>setTagName(event.currentTarget.value)} placeholder="Ex.: Em espera" required/></label><label>Etiqueta superior<select value={tagParent} onChange={event=>setTagParent(event.currentTarget.value)}><option value="">Nenhuma</option>{sortedTags.filter(tag=>tag.id!==editingTagId).map(tag=><option key={tag.id} value={tag.id}>{tag.parentId!==null?'— ':''}{tag.name}</option>)}</select></label><label>Atalho<input maxLength={4} value={tagShortcut} onChange={event=>setTagShortcut(event.currentTarget.value)} placeholder="Opcional"/></label><button className="primary" disabled={saving||!tagName.trim()}>{editingTagId===null?<><Plus size={14}/> Criar etiqueta</>:'Salvar etiqueta'}</button>{editingTagId!==null&&<button type="button" className="text-button" onClick={()=>{setEditingTagId(null);setTagName('');setTagParent('');setTagShortcut('');}}>Cancelar</button>}</form>
   <div className="tag-tree">{sortedTags.map(tag=><div className={'tag-tree-row '+(tag.parentId!==null?'tag-child':'')} key={tag.id}><span>{tag.parentId!==null?'↳ ':''}{tag.name}{tag.shortcut&&<small> · {tag.shortcut}</small>}</span><button className="text-button" onClick={()=>editTag(tag)}>Editar</button><button className="icon-button" aria-label="Excluir etiqueta" onClick={()=>void deleteTag(tag)}><Trash2 size={14}/></button></div>)}{!sortedTags.length&&<p className="empty">Ainda não há etiquetas.</p>}</div>
   {tagError&&<p className="save-error" role="alert">{tagError}</p>}
  </div>
 </section>;
}
