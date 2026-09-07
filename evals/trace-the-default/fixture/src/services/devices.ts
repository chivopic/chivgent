export interface Device {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseDevice(raw: Device): Device {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
