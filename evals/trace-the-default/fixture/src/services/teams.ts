export interface Team {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseTeam(raw: Team): Team {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
