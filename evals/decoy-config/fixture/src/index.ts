import { httpSettings } from "./settings/http.js";

export async function fetchUser(id: string) {
  const response = await fetch(`${httpSettings.baseUrl}/users/${id}`, {
    signal: AbortSignal.timeout(httpSettings.timeoutSeconds * 1000),
  });
  return response.json();
}
