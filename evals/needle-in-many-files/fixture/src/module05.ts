export interface Options05 {
  readonly enabled: boolean;
}

export function configure05(options: Options05): Options05 {
  return { ...options };
}
