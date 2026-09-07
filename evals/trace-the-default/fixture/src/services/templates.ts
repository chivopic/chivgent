export interface Template {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseTemplate(raw: Template): Template {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
