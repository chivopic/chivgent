export interface Session {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseSession(raw: Session): Session {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
