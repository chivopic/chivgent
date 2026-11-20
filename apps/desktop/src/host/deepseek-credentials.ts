import { isCredentialRequest, isCredentialResult, MAX_CREDENTIAL_PAYLOAD_LENGTH, type CredentialRequest, type CredentialResult, type DeepSeekCredentialCodec } from "../protocol/credentials.js";

export function createDeepSeekCredentialClient(send: (message: CredentialRequest) => void) {
  let currentId = 0;
  const pending = new Map<number, (result: CredentialResult) => void>();

  async function request(operation: CredentialRequest["operation"], value: string): Promise<string> {
    const id = ++currentId;
    const message = { type: "deepseek-credential-request", id, operation, value } as const;
    if (!isCredentialRequest(message)) throw new Error("Invalid desktop credential payload.");
    const result = await new Promise<CredentialResult>((resolve) => {
      pending.set(id, resolve);
      try {
        send(message);
      } catch {
        pending.delete(id);
        resolve({ type: "deepseek-credential-result", id, ok: false });
      }
    });
    if (!result.ok || result.value.length === 0 || result.value.length > MAX_CREDENTIAL_PAYLOAD_LENGTH) {
      throw new Error("Desktop credentials unavailable.");
    }
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
