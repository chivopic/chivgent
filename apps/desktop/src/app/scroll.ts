export function isNearBottom(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 48,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}
