import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { displayWidth } from "./text.js";

export const FOOTER_FIELDS = ["identity", "mode", "workspace", "context", "session", "tokens", "branch"] as const;
export type FooterField = typeof FOOTER_FIELDS[number];
export const DEFAULT_FOOTER_FIELDS: readonly FooterField[] = ["identity", "mode"];

export function formatFooterFields(fields: readonly FooterField[], values: Partial<Record<FooterField, string | undefined>>, width?: number): string {
  const text = fields.flatMap(field => values[field] === undefined ? [] : [values[field]!]).join(" · ");
  const mode = fields.includes("mode") ? values.mode : undefined;
  return width !== undefined && mode !== undefined && displayWidth(text) > width && displayWidth(mode) <= width
    ? mode
    : text;
}

export function parseFooterFields(value: string): readonly FooterField[] | undefined {
  const fields = value.split(",").map(field => field.trim()).filter(Boolean);
  if (fields.length === 0 || fields.some(field => !(FOOTER_FIELDS as readonly string[]).includes(field))) return undefined;
  if (new Set(fields).size !== fields.length) return undefined;
  return fields as FooterField[];
}

export async function readFooterFields(file: string): Promise<readonly FooterField[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("footerFields" in parsed) || !Array.isArray(parsed.footerFields)) throw new TypeError("Invalid footer preferences.");
    const fields = parsed.footerFields;
    if (fields.length === 0 || fields.some(field => typeof field !== "string" || !(FOOTER_FIELDS as readonly string[]).includes(field)) || new Set(fields).size !== fields.length) throw new TypeError("Invalid footer preferences.");
    return fields as FooterField[];
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return DEFAULT_FOOTER_FIELDS;
    throw error;
  }
}

export async function writeFooterFields(file: string, fields: readonly FooterField[]): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify({ footerFields: fields }, null, 2)}\n`, "utf8"); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
