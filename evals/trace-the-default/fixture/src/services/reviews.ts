export interface Review {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseReview(raw: Review): Review {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
