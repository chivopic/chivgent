export interface Options02 {
  readonly enabled: boolean;
}

export function configure02(options: Options02): Options02 {
  return { ...options };
}
