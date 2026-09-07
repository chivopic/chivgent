export interface Webhook {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseWebhook(raw: Webhook): Webhook {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
