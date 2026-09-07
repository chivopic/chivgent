export interface User {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseUser(raw: User): User {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
