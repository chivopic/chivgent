import { safeStorage } from "electron";
import type { DeepSeekCredentialCodec } from "../protocol/credentials.js";

export const deepSeekCredentialCodec: DeepSeekCredentialCodec = {
  async encrypt(key) {
    if (!await safeStorage.isAsyncEncryptionAvailable() ||
        (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
      throw new Error("System credential storage is unavailable.");
    }
    return (await safeStorage.encryptStringAsync(key)).toString("base64");
  },
  async decrypt(ciphertext) {
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(ciphertext, "base64"));
    if (result.trim().length === 0) throw new Error("Empty DeepSeek credential.");
    return result;
  },
};
