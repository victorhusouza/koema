import { validDate } from './task-dates.ts';

export type ThingsPlacement = 'inbox' | 'anytime' | 'someday' | 'today' | 'evening' | 'upcoming';

/** Apply the agreed import mapping after the source list has been identified. */
export function mapThingsPlacement(
 placement: ThingsPlacement,
 options: { importDay: string; plannedDate?: string | null },
): { when: string; plannedDate: string | null } {
 if (!validDate(options.importDay)) throw new Error('Invalid import date.');
 if (options.plannedDate != null && !validDate(options.plannedDate)) throw new Error('Invalid planned date.');
 switch (placement) {
  case 'anytime':
  case 'someday':
   return { when: 'Algum dia', plannedDate: null };
  case 'evening':
  case 'today':
   return { when: 'Hoje', plannedDate: options.importDay };
  case 'upcoming':
   if (!options.plannedDate) throw new Error('An upcoming task requires its original planned date.');
   return { when: 'Planejada', plannedDate: options.plannedDate };
  case 'inbox':
   return { when: 'Caixa de entrada', plannedDate: null };
  default:
   throw new Error('Unknown Things placement.');
 }
}
