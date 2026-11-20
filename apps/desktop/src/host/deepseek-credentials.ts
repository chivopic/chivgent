import { isCredentialResult, type CredentialRequest, type CredentialResult, type DeepSeekCredentialCodec } from "../protocol/credentials.js";

export function createDeepSeekCredentialClient(send: (message: CredentialRequest) => void) {
  let currentId = 0;
  const pending = new Map<number, (result: CredentialResult) => void>();

  async function request(operation: CredentialRequest["operation"], value: string): Promise<string> {
    const id = ++currentId;
    const result = await new Promise<CredentialResult>((resolve) => {
      pending.set(id, resolve);
      try {
        send({ type: "deepseek-credential-request", id, operation, value });
      } catch {
        pending.delete(id);
        resolve({ type: "deepseek-credential-result", id, ok: false });
      }
    });
    if (!result.ok) throw new Error("Desktop credentials unavailable.");
    return result.value;
  }

  const codec: DeepSeekCredentialCodec = {
    encrypt: (value) => request("encrypt", value),
    decrypt: (value) => request("decrypt", value),
  };

  return {
    codec,
    receive(message: unknown): boolean {
      if (!isCredentialResult(message)) return false;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return true;
    },
  };
}
