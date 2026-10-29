export type Task = {
 id: number;
 areaId?: number | null;
 projectId?: number | null;
 headingId?: number | null;
 tagIds?: number[];
 effectiveTagIds?: number[];
 areaName?: string;
 projectName?: string;
 plannedDate?: string | null;
 deadline?: string | null;
 reminderAt?: string | null;
 createdAt?: string;
 updatedAt?: string;
 sourceId?: string;
 scheduleId?: number | null;
 scheduledFor?: string | null;
 position?: number;
 title: string;
 project: string;
 when: string;
 done: boolean;
 notes: string;
 checklist: { text: string; done: boolean }[];
 completed?: string;
 recurrence?: 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'monthly' | null;
 recurrenceAnchor?: string;
 seriesId?: number;
 occurrence?: number;
 previousId?: number;
 successorId?: number;
 successorSnapshot?: string;
};
export const seed: Task[] = [
 { id: 11, title: 'Mandar promos e emissões', project: '', when: 'Hoje', done: false, notes: '', checklist: [], recurrence: 'daily' },
 { id: 1, title: 'Preparar a proposta do novo projeto', project: 'Trabalho · Proposta comercial', when: 'Hoje', done: false, notes: 'Reunir as ideias principais e preparar uma primeira versão para revisar com calma.', checklist: [{ text: 'Revisar o escopo', done: true }, { text: 'Organizar entregas e prazos', done: false }] },
 { id: 2, title: 'Revisar os materiais para a reunião', project: 'Trabalho', when: 'Hoje', done: false, notes: '', checklist: [] },
 { id: 3, title: 'Reservar um tempo para leitura', project: 'Pessoal', when: 'Hoje', done: false, notes: 'Continuar o livro da semana.', checklist: [] },
 { id: 4, title: 'Organizar as referências do projeto', project: 'Trabalho · Proposta comercial', when: 'Amanhã', done: false, notes: '', checklist: [] },
 { id: 5, title: 'Planejar as refeições da semana', project: 'Pessoal', when: 'Amanhã', done: false, notes: '', checklist: [] },
 { id: 6, title: 'Revisar o planejamento semanal', project: 'Pessoal', when: 'Sex, 30 out', done: false, notes: '', checklist: [] },
 { id: 7, title: 'Pesquisar destinos para as férias', project: 'Pessoal', when: 'Sáb, 31 out', done: false, notes: '', checklist: [] },
 { id: 8, title: 'Conhecer uma nova trilha', project: 'Pessoal', when: 'Algum dia', done: false, notes: '', checklist: [] },
 { id: 9, title: 'Anotar ideias para o próximo mês', project: '', when: 'Caixa de entrada', done: false, notes: '', checklist: [] },
 { id: 10, title: 'Organizar a mesa de trabalho', project: 'Pessoal', when: 'Hoje', done: true, completed: '28 out · 07:45', notes: '', checklist: [] },
];
