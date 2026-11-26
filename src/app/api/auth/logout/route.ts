import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export const runtime = "nodejs";

// POST only, and only from the dashboard's own pages. A GET logout let any other site sign
// the owner out with a plain link or an <img>, because a top-level GET carries the
// SameSite=Lax session cookie. Browsers send Origin on every POST, so a missing or foreign
// Origin is refused.
export async function POST(req: NextRequest) {
  if (req.headers.get("origin") !== req.nextUrl.origin) {
    return NextResponse.json({ error: "cross-site logout refused" }, { status: 403 });
  }

  // 303 so the browser follows with a GET to /login, not a second POST.
  const response = NextResponse.redirect(new URL("/login", req.url), 303);
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
