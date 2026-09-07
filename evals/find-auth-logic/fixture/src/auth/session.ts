const SECRET = process.env.SESSION_SECRET ?? "";

/** Checks a bearer token against the session secret. */
export function verifyToken(header: string | null): boolean {
  if (header === null || !header.startsWith("Bearer ")) {
    return false;
  }
  return header.slice("Bearer ".length) === SECRET;
}
