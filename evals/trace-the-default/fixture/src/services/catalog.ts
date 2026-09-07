export interface Product {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseProduct(raw: Product): Product {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
