export interface Account {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseAccount(raw: Account): Account {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
