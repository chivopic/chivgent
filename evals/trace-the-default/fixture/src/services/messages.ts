export interface Message {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseMessage(raw: Message): Message {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
