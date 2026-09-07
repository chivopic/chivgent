export interface Feed {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseFeed(raw: Feed): Feed {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
