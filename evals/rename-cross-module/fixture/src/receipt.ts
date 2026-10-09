import { formatPrice } from "./money/format.js";

export function receiptLine(label: string, priceCents: number): string {
  return label + ": " + formatPrice(priceCents);
}
