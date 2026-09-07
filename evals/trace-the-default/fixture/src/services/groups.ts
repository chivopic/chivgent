export interface Group {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseGroup(raw: Group): Group {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
