import { verifyToken } from "./auth/session.js";

export function handle(request: Request): Response {
  if (!verifyToken(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }
  return new Response("ok");
}
