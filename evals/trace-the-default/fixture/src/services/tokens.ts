export interface Token {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseToken(raw: Token): Token {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
