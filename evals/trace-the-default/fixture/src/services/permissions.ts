export interface Permission {
  readonly id: string;
  readonly createdAt: string;
}

export function normalisePermission(raw: Permission): Permission {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
