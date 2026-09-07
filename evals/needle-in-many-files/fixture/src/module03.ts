export interface Options03 {
  readonly enabled: boolean;
}

export function configure03(options: Options03): Options03 {
  return { ...options };
}
