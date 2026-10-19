import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixtureDirectory = new URL("./fixtures/protocol/", import.meta.url);

// Fixtures are hand-authored protocol examples, not output from the app's serializer.
export async function replayProtocol(response, name, { model, replacements = {}, chunkBytes = Infinity, delayMs = 0 } = {}) {
  const source = await readFile(new URL(name, fixtureDirectory), "utf8");
  let payload = source.replaceAll("{{MODEL}}", model ?? "synthetic-fixture");
  for (const [key, value] of Object.entries(replacements)) payload = payload.replaceAll(`{{${key}}}`, value);
  const bytes = Buffer.from(payload);
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    response.write(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)));
    if (delayMs > 0) await new Promise((accept) => setTimeout(accept, delayMs));
    else await new Promise((accept) => setImmediate(accept));
  }
}

export const finishReplay = (response) => response.end("data: [DONE]\n\n");

export async function replayFragmentedPrefix(response, name, options = {}) {
  const { hold = false, ...replayOptions } = options;
  await replayProtocol(response, name, { chunkBytes: 3, ...replayOptions });
  if (!hold) finishReplay(response);
}

export function syntheticFixtureSource(name) {
  return fileURLToPath(new URL(name, fixtureDirectory));
}
