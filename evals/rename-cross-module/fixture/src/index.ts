import { formatPrice, formatPrices } from "./money/format.js";
import { checkoutLabel } from "./cart/checkout.js";

export const banner = formatPrice(950);
export const examples = formatPrices([100, 250]);
export const checkout = checkoutLabel(1250);
