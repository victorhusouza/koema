import { capitalizeLines } from './text.ts';

export type Briefing = {
 date: string;
 Hoje: string;
 Pendências: string;
 Semana: string;
 updatedAt: string;
};

export const initialBrief: Briefing = {
 date: '2026-10-27',
 Hoje: 'Revise suas prioridades e reserve tempo para o que importa.',
 Pendências: 'Confira as tarefas que precisam de acompanhamento.',
 Semana: 'Organize os próximos passos dos seus projetos.',
 updatedAt: '',
};

export class BriefingInputError extends Error {}

export function validBriefingDate(date: unknown): date is string {
 if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
 const parsed = new Date(`${date}T00:00:00.000Z`);
 return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function validateBriefingInput(input: unknown): Pick<Briefing, 'Hoje' | 'Pendências' | 'Semana'> {
 if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BriefingInputError('Informe as três seções do briefing.');
 const value = input as Record<string, unknown>;
 const fields = ['Hoje', 'Pendências', 'Semana'] as const;
 if (Object.keys(value).length !== fields.length || fields.some(field => typeof value[field] !== 'string')) {
  throw new BriefingInputError('Informe Hoje, Pendências e Semana como texto.');
 }
 const result = {} as Pick<Briefing, typeof fields[number]>;
 let total = 0;
 for (const field of fields) {
  const text = value[field] as string;
  if (text.length > 20000) throw new BriefingInputError(`A seção ${field} excede o limite de 20.000 caracteres.`);
  total += text.length;
  result[field] = capitalizeLines(text);
 }
 if (total > 40000) throw new BriefingInputError('O briefing excede o limite total de 40.000 caracteres.');
 return result;
}
