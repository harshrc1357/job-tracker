import { NextRequest, NextResponse } from "next/server";
import { isOwnerSession, isSessionSecretUsable, MIN_SESSION_SECRET_LENGTH, SESSION_COOKIE_NAME } from "@/lib/session";
import { isPublicPath } from "@/lib/publicPaths";

// Gates the dashboard and the Gmail OAuth connect routes behind Google sign-in,
// restricted to OWNER_EMAIL. The paths in publicPaths.ts are the only exceptions: sign-in
// itself, the privacy policy Google's consent screen must fetch, and /api/sync, which an
// external cron calls with no browser involved. /api/sync decides for itself what a
// caller may see: only a caller holding CRON_SECRET gets counts and errors back.
//
// Fails closed on purpose: if SESSION_SECRET (32+ characters) or OWNER_EMAIL isn't set, every gated
// route returns 500 rather than silently serving the dashboard to the public internet.
//
// This is not the only check. Server actions and /api/applications/[id] call
// requireOwner() themselves, so a mistake in this file or the matcher cannot expose them.
export async function middleware(req: NextRequest) {
  if (isPublicPath(req.nextUrl.pathname)) return NextResponse.next();

  if (!isSessionSecretUsable() || !process.env.OWNER_EMAIL) {
    return new NextResponse(
      `OWNER_EMAIL is not set, or SESSION_SECRET is not set or shorter than ${MIN_SESSION_SECRET_LENGTH} characters — refusing to serve this publicly.`,
      { status: 500 }
    );
  }

  if (await isOwnerSession(req.cookies.get(SESSION_COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  // Only Next's own static assets are excluded here, and anchored so that nothing else
  // can share their prefix. Without the exclusion, every asset request on the logged-out
  // /login page (its CSS, its JS chunks) gets caught by the "no session -> redirect to
  // /login" branch and comes back as an HTML redirect body instead of CSS/JS, so the
  // login page renders completely unstyled. Once signed in this is invisible, because the
  // valid cookie makes every request pass through regardless of path. Which routes are
  // public is decided by isPublicPath() above, never by this pattern.
  matcher: ["/((?!_next/static/|_next/image(?:/|$)|favicon\\.ico$).*)"],
};
