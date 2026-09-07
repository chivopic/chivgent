export interface Order {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseOrder(raw: Order): Order {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
