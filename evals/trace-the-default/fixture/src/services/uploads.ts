export interface Upload {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseUpload(raw: Upload): Upload {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
