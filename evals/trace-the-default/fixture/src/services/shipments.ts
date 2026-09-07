export interface Shipment {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseShipment(raw: Shipment): Shipment {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
