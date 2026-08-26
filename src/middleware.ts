import { NextRequest, NextResponse } from "next/server";

// Gates the dashboard and the Gmail OAuth connect routes behind a single shared
// password. /api/sync is deliberately excluded (see matcher below) — it's hit by an
// external cron trigger with no browser involved, and already checks its own
// CRON_SECRET query param instead.
//
// Fails closed on purpose: if DASHBOARD_PASSWORD isn't set, every gated route returns
// 500 rather than silently serving the dashboard to the public internet.
export function middleware(req: NextRequest) {
  const expectedPassword = process.env.DASHBOARD_PASSWORD;

  if (!expectedPassword) {
    return new NextResponse("DASHBOARD_PASSWORD is not set — refusing to serve this publicly.", {
      status: 500,
    });
  }

  const expectedUser = process.env.DASHBOARD_USER || "elon";
  const header = req.headers.get("authorization");

  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const separatorIndex = decoded.indexOf(":");
    const user = decoded.slice(0, separatorIndex);
    const pass = decoded.slice(separatorIndex + 1);

    if (user === expectedUser && pass === expectedPassword) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Job Tracker"' },
  });
}

export const config = {
  matcher: ["/((?!api/sync).*)"],
};
