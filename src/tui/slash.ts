export interface SlashSuggestion {
  readonly value: string;
  readonly label: string;
}

/**
 * Pure, non-executable command discovery for the in-place composer.
 * Never interpret arbitrary model text as a command; only the REPL dispatcher
 * can execute after the user explicitly submits a completed prompt.
 */
export function slashSuggestions(
  draft: string,
  cursor: number,
  commands: readonly SlashSuggestion[],
): readonly SlashSuggestion[] {
  if (cursor !== draft.length || !/^\/[a-z0-9_-]*$/i.test(draft)) return [];
  const typed = draft.slice(1).toLowerCase();
  return commands.filter(command =>
    /^[a-z][a-z0-9_-]*$/i.test(command.value) &&
    command.value.toLowerCase().startsWith(typed),
  ).slice(0, 5);
}
