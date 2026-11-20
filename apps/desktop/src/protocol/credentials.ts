// Private main/utility exchange. Credential payloads never reach the renderer.
export const MAX_CREDENTIAL_PAYLOAD_LENGTH = 8_192;

export interface DeepSeekCredentialCodec {
  encrypt(apiKey: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export interface CredentialRequest {
  readonly type: "deepseek-credential-request";
  readonly id: number;
  readonly operation: "encrypt" | "decrypt";
  readonly value: string;
}

export type CredentialResult = { readonly type: "deepseek-credential-result"; readonly id: number } & (
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false }
);

export function isCredentialRequest(value: unknown): value is CredentialRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<CredentialRequest>;
  return request.type === "deepseek-credential-request" && Number.isSafeInteger(request.id) &&
    (request.operation === "encrypt" || request.operation === "decrypt") &&
    typeof request.value === "string" && request.value.length > 0 && request.value.length <= MAX_CREDENTIAL_PAYLOAD_LENGTH;
}

export function isCredentialResult(value: unknown): value is CredentialResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { type?: unknown; id?: unknown; ok?: unknown; value?: unknown };
  return result.type === "deepseek-credential-result" && Number.isSafeInteger(result.id) &&
    (result.ok === false || (result.ok === true && typeof result.value === "string"));
}
