export interface Report {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseReport(raw: Report): Report {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
