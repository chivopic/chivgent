export interface Options32 {
  readonly enabled: boolean;
}

export function configure32(options: Options32): Options32 {
  return { ...options };
}
