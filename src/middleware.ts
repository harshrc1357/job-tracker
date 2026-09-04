import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";

// Gates the dashboard and the Gmail OAuth connect routes behind Google sign-in,
// restricted to OWNER_EMAIL. /api/sync is excluded (see matcher) — it's hit by an
// external cron trigger with no browser involved, and checks its own CRON_SECRET
// query param instead. /login and /api/auth/login (and its callback) are excluded
// too, or signing in would redirect into itself forever. /privacy is excluded
// because it has to be publicly reachable — it's the privacy policy URL Google's
// OAuth consent screen and Search Console domain verification both need to fetch
// without a session.
//
// Fails closed on purpose: if SESSION_SECRET or OWNER_EMAIL isn't set, every gated
// route returns 500 rather than silently serving the dashboard to the public internet.
export async function middleware(req: NextRequest) {
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!process.env.SESSION_SECRET || !ownerEmail) {
    return new NextResponse("SESSION_SECRET / OWNER_EMAIL is not set — refusing to serve this publicly.", {
      status: 500,
    });
  }

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const email = token ? await verifySessionToken(token) : null;

  if (email && email.toLowerCase() === ownerEmail.toLowerCase()) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  // _next/static, _next/image and favicon.ico must stay excluded alongside the
  // auth routes: without this, every asset request on the logged-out /login
  // page (its CSS, its JS chunks) gets caught by the matcher too, hits the
  // "no session -> redirect to /login" branch below, and comes back as an HTML
  // redirect body instead of CSS/JS. The browser then fails to parse it and the
  // login page renders completely unstyled. Once signed in this is invisible,
  // because the valid cookie makes every request pass through regardless of
  // path — it only shows up for a logged-out visitor.
  matcher: ["/((?!api/sync|api/auth/login|login|privacy|_next/static|_next/image|favicon.ico).*)"],
};
