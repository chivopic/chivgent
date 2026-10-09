import { roundCents } from "./rounding.js";

export function formatPrice(cents: number): string {
  const rounded = roundCents(cents);
  return "$" + (rounded / 100).toFixed(2);
}

export function formatPrices(values: readonly number[]): string[] {
  return values.map(formatPrice);
}
