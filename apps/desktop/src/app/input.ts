export interface EnterKey {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
  /** Set for the Enter that confirms an IME candidate after compositionend. */
  readonly ignoreEnter: boolean;
}

/**
 * Enter submits. Shift+Enter inserts a newline. An IME confirmation Enter
 * must not submit: some engines report it as isComposing, some as keyCode 229,
 * and some fire it just after compositionend with both already cleared.
 */
export function shouldSubmitOnEnter(key: EnterKey): boolean {
  if (key.key !== "Enter" || key.shiftKey) {
    return false;
  }
  if (key.ignoreEnter || key.isComposing || key.keyCode === 229) {
    return false;
  }
  return true;
}

export function nextRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) {
    return uuid;
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
