export interface Payment {
  readonly id: string;
  readonly createdAt: string;
}

export function normalisePayment(raw: Payment): Payment {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
