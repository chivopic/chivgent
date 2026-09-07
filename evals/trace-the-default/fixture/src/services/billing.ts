export interface Invoice {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseInvoice(raw: Invoice): Invoice {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
