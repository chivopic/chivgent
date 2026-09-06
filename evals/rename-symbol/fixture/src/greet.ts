export function sayHi(name: string): string {
  return `Hi, ${name}!`;
}

export function shout(name: string): string {
  return sayHi(name).toUpperCase();
}
