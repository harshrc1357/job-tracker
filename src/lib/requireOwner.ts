import { cookies } from "next/headers";
import { isOwnerSession, SESSION_COOKIE_NAME } from "@/lib/session";

// The middleware already keeps strangers away from every page, but a server action is a
// POST that anyone who knows its id can send, and /api/applications/[id] serves whole
// email bodies. Each of them asks again here, so one mistake in the middleware matcher
// (it has had prefix gaps) cannot expose them.
export async function isOwnerRequest(): Promise<boolean> {
  const store = await cookies();
  return isOwnerSession(store.get(SESSION_COOKIE_NAME)?.value);
}

// For server actions: throws, which Next turns into a failed action with no data.
export async function requireOwner(): Promise<void> {
  if (!(await isOwnerRequest())) throw new Error("unauthorized");
}
