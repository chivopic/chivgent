export interface Favourite {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseFavourite(raw: Favourite): Favourite {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
