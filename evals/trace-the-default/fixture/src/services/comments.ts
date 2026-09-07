export interface Comment {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseComment(raw: Comment): Comment {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
