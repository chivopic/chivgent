export interface Receipt {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseReceipt(raw: Receipt): Receipt {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
