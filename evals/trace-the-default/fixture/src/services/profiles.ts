export interface Profile {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseProfile(raw: Profile): Profile {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
