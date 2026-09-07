export interface Export {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseExport(raw: Export): Export {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
