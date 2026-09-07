export interface Label {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseLabel(raw: Label): Label {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
