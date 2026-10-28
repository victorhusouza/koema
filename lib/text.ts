/** Capitalizes only the initial letter, preserving numbers and names such as iPhone. */
export function capitalizeInitial(text: string): string {
  return text.replace(/^(\s*(?:[-*•]\s+)?)(\p{L})(\p{Lu})?/u, (match, prefix: string, first: string, second?: string) =>
    second ? match : prefix + first.toLocaleUpperCase('pt-BR')
  );
}

export function capitalizeLines(text: string): string {
  return text.split('\n').map(capitalizeInitial).join('\n');
}
