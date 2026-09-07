export interface Tag {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseTag(raw: Tag): Tag {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
