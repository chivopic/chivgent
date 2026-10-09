import { formatPrice } from "../money/format.js";

export function checkoutLabel(totalCents: number): string {
  return "Total: " + formatPrice(totalCents);
}
