export interface Invite {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseInvite(raw: Invite): Invite {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
