export interface Project {
  readonly id: string;
  readonly createdAt: string;
}

export function normaliseProject(raw: Project): Project {
  return { id: raw.id.trim(), createdAt: raw.createdAt };
}
