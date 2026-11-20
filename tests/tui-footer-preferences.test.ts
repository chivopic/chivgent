import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FOOTER_FIELDS, formatFooterFields, parseFooterFields, readFooterFields, writeFooterFields } from "../src/tui/footer-preferences.js";

describe("footer preferences", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  it("validates unique selectable fields and persists the selected order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chivgent-ui-settings-"));
    roots.push(root);
    const file = path.join(root, "statusline.json");
    const fields = parseFooterFields("mode,context,identity");
    expect(fields).toEqual(["mode", "context", "identity"]);
    expect(parseFooterFields("mode,mode")).toBeUndefined();
    await writeFooterFields(file, fields!);
    expect(await readFooterFields(file)).toEqual(fields);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ footerFields: fields });
    expect(formatFooterFields(fields!, { mode: "Ask · /help", context: "ctx 64k", identity: "openai · gpt" }))
      .toBe("Ask · /help · ctx 64k · openai · gpt");
    expect(formatFooterFields(["identity", "context"], {
      mode: "Plan", identity: "openai · gpt", context: "ctx 64k",
    }, 12)).toBe("openai · gpt · ctx 64k");
  });

  it("uses defaults only when missing and preserves invalid preference files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chivgent-ui-settings-"));
    roots.push(root);
    const file = path.join(root, "statusline.json");
    expect(await readFooterFields(file)).toEqual(DEFAULT_FOOTER_FIELDS);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    await writeFile(file, '{"footerFields":["credential"]}');
    const before = await readFile(file, "utf8");
    await expect(readFooterFields(file)).rejects.toThrow("Invalid footer preferences");
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
