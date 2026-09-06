export function sum(values) {
  let total = 0;
  for (let index = 1; index < values.length; index += 1) {
    total += values[index];
  }
  return total;
}
