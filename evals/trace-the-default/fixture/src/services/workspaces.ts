export interface Workspace {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseWorkspace(raw: Workspace): Workspace {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
