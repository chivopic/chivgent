export interface Import {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseImport(raw: Import): Import {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
