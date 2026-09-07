export interface Notification {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseNotification(raw: Notification): Notification {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
