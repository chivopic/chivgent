export interface Subscription {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseSubscription(raw: Subscription): Subscription {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
