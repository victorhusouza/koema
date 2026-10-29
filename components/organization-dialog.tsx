'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Area, Project } from '../lib/task-store';

export type OrganizationDialogState =
 | { kind: 'area-create' }
 | { kind: 'area-rename'; area: Area }
 | { kind: 'project-create'; initialAreaId?: number }
 | { kind: 'project-edit'; project: Project }
 | { kind: 'project-status'; project: Project; openTaskCount: number };

type OrganizationDialogProps = {
 dialog: OrganizationDialogState;
 areas: Area[];
 returnFocusTarget: HTMLElement | null;
 onClose: () => void;
 onCreateArea: (name: string) => Promise<void>;
 onRenameArea: (areaId: number, name: string) => Promise<void>;
 onCreateProject: (name: string, areaId: number) => Promise<void>;
 onEditProject: (projectId: number, name: string, areaId: number) => Promise<void>;
 onSetProjectStatus: (projectId: number, status: 'open' | 'completed') => Promise<void>;
};

function dialogHeading(dialog: OrganizationDialogState) {
 switch (dialog.kind) {
  case 'area-create': return 'Criar área';
  case 'area-rename': return 'Renomear área';
  case 'project-create': return 'Criar projeto';
  case 'project-edit': return 'Editar projeto';
  case 'project-status': return dialog.project.status === 'open' ? 'Concluir projeto' : 'Reabrir projeto';
 }
}

export default function OrganizationDialog(props: OrganizationDialogProps) {
 const { dialog, areas, onClose } = props;
 const [name, setName] = useState(dialog.kind === 'area-rename' ? dialog.area.name : dialog.kind === 'project-edit' ? dialog.project.name : '');
 const [areaId, setAreaId] = useState<number>(() => dialog.kind === 'project-edit' ? dialog.project.areaId : dialog.kind === 'project-create' && dialog.initialAreaId ? dialog.initialAreaId : areas[0]?.id ?? 0);
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState('');
 const savingRef = useRef(false);
 const dialogRef = useRef<HTMLDivElement>(null);
 const focusRef = useRef<HTMLInputElement>(null);

 useLayoutEffect(() => {
  (focusRef.current || dialogRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])'))?.focus();
  const node = dialogRef.current;
  return () => { requestAnimationFrame(() => { if (!node?.isConnected) props.returnFocusTarget?.focus(); }); };
 }, []);
 function requestClose() { if (!savingRef.current) onClose(); }

 async function save(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (savingRef.current) return;
  savingRef.current = true;
  setSaving(true); setError('');
  try {
   switch (dialog.kind) {
    case 'area-create': await props.onCreateArea(name.trim()); break;
    case 'area-rename': await props.onRenameArea(dialog.area.id, name.trim()); break;
    case 'project-create': await props.onCreateProject(name.trim(), areaId); break;
    case 'project-edit': await props.onEditProject(dialog.project.id, name.trim(), areaId); break;
    case 'project-status': await props.onSetProjectStatus(dialog.project.id, dialog.project.status === 'open' ? 'completed' : 'open'); break;
   }
   onClose();
  } catch (cause) {
   setError(cause instanceof Error ? cause.message : 'Não foi possível salvar as alterações.');
  } finally { savingRef.current = false; setSaving(false); }
 }
 function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); requestClose(); }
  if (event.key === 'Tab') {
   const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])');
   if (!controls?.length) return;
   const first = controls[0], last = controls[controls.length - 1];
   if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
   else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
 }
 const asksForName = dialog.kind !== 'project-status';
 const asksForArea = dialog.kind === 'project-create' || dialog.kind === 'project-edit';
 const canComplete = dialog.kind !== 'project-status' || dialog.project.status !== 'open' || dialog.openTaskCount === 0;

 return <div className="modal-backdrop organization-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
  <div ref={dialogRef} className="modal organization-dialog" role="dialog" aria-modal="true" aria-labelledby="organization-dialog-title" onKeyDown={keyDown}>
   <div className="section-top"><h2 id="organization-dialog-title">{dialogHeading(dialog)}</h2><button type="button" className="icon-button" aria-label="Fechar" disabled={saving} onClick={requestClose}><X size={17}/></button></div>
   {dialog.kind === 'project-status' ? <form onSubmit={save}>
    <p className="dialog-copy">{dialog.project.name}</p>
    {dialog.project.status === 'open' && dialog.openTaskCount > 0
     ? <p className="muted">Ainda há {dialog.openTaskCount} tarefa{dialog.openTaskCount === 1 ? '' : 's'} aberta{dialog.openTaskCount === 1 ? '' : 's'} neste projeto. Conclua essas tarefas antes de concluir o projeto.</p>
     : <p className="muted">{dialog.project.status === 'open' ? 'Marque este projeto como concluído.' : 'O projeto voltará a aparecer como em andamento.'}</p>}
    {error && <p className="save-error" role="alert">{error}</p>}
    <div className="organization-dialog-actions"><button type="button" className="secondary" disabled={saving} onClick={requestClose}>Cancelar</button><button type="submit" className="primary" disabled={saving || !canComplete}>{saving ? 'Salvando…' : dialog.project.status === 'open' ? 'Concluir projeto' : 'Reabrir projeto'}</button></div>
   </form> : <form onSubmit={save}>
    {asksForName && <label>{dialog.kind.startsWith('area') ? 'Nome da área' : 'Nome do projeto'}<input ref={focusRef} maxLength={120} required value={name} onChange={event => setName(event.currentTarget.value)}/></label>}
    {asksForArea && <label>Área<select value={areaId || ''} required onChange={event => setAreaId(Number(event.currentTarget.value))}>{areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>}
    {error && <p className="save-error" role="alert">{error}</p>}
    <div className="organization-dialog-actions"><button type="button" className="secondary" disabled={saving} onClick={requestClose}>Cancelar</button><button type="submit" className="primary" disabled={saving || !name.trim() || (asksForArea && !areas.some(area => area.id === areaId))}>{saving ? 'Salvando…' : 'Salvar'}</button></div>
   </form>}
  </div>
 </div>;
}
