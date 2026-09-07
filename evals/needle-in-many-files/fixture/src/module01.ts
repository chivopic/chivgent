export interface Options01 {
  readonly enabled: boolean;
}

export function configure01(options: Options01): Options01 {
  return { ...options };
}
