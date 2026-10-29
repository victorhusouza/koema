'use client';
import { Folder, Plus } from 'lucide-react';
import type { Area, Project } from '../lib/task-store';

type OrganizationPanelProps = {
 areas: Area[];
 projects: Project[];
 openTaskCount: (scope: { areaId?: number; projectId?: number }) => number;
 onCreateArea: () => void;
 onRenameArea: (area: Area) => void;
 onCreateProject: (areaId?: number) => void;
 onEditProject: (project: Project) => void;
 onSetProjectStatus: (project: Project) => void;
};

export default function OrganizationPanel({ areas, projects, openTaskCount, onCreateArea, onRenameArea, onCreateProject, onEditProject, onSetProjectStatus }: OrganizationPanelProps) {
 return <section className="card list-view organization-panel">
  <div className="section-top"><h2>Áreas</h2><button className="text-button" onClick={onCreateArea}><Plus size={16}/> Nova área</button></div>
  {areas.length === 0 && <p className="empty">Crie uma área para reunir responsabilidades e projetos.</p>}
  {areas.map(area => <div className="organization-row" key={area.id}>
   <div><strong>{area.name}</strong><small>{openTaskCount({ areaId: area.id })} tarefas abertas</small></div>
   <button className="text-button" onClick={() => onRenameArea(area)}>Renomear</button>
   <button className="text-button" onClick={() => onCreateProject(area.id)}><Plus size={15}/> Projeto</button>
  </div>)}
  <div className="section-top organization-heading"><h2>Projetos</h2><button className="text-button" onClick={() => onCreateProject()}><Plus size={16}/> Novo projeto</button></div>
  {projects.length === 0 && <p className="empty">Ainda não há projetos.</p>}
  {projects.map(project => {
   const openCount = openTaskCount({ projectId: project.id });
   return <div className="organization-row" key={project.id}>
    <div><strong><Folder size={14}/> {project.name}</strong><small>{project.areaName} · {project.status === 'completed' ? 'Concluído' : 'Em andamento'} · {openCount} tarefas abertas</small></div>
    <button className="text-button" onClick={() => onEditProject(project)}>Editar</button>
    <button className="text-button" onClick={() => onSetProjectStatus(project)}>{project.status === 'open' ? 'Concluir' : 'Reabrir'}</button>
   </div>;
  })}
 </section>;
}
