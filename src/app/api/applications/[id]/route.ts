import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { applications } from "@/db/schema";

// The full HTML body of one email, fetched when the user actually clicks it.
//
// It exists because the dashboard used to ship every column of every row, and
// bodyHtml was 87% of that payload (1863 kB of 2142 kB at 212 rows) to render one
// message nobody had opened yet. The list query now omits it and this route serves it
// one at a time.
//
// No auth check in here on purpose, and that is only safe because of the matcher in
// src/middleware.ts: it excludes /api/sync and the login routes and gates everything
// else behind the OWNER_EMAIL session, so this path is already covered. If that
// matcher is ever widened, this route needs its own check.
export const runtime = "nodejs";

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  // Parsed rather than passed through. Drizzle parameterises the query either way, so
  // this is about returning a clean 400 instead of a database type error.
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const [row] = await db
      .select({ bodyHtml: applications.bodyHtml, body: applications.body })
      .from(applications)
      .where(eq(applications.id, numericId))
      .limit(1);

    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Already sanitized at sync time by sanitizeEmailHtml (scripts and event handlers
    // stripped before it ever reached the database), and rendered into a sandboxed
    // iframe on the client. Nothing further to do to it here.
    return NextResponse.json(row, {
      // A stored email never changes, so the browser may keep it for the session.
      // private, because it is one person's mail and must not land in a shared cache.
      headers: { "Cache-Control": "private, max-age=3600" },
    });
  } catch (err) {
    console.error("[applications] fetch failed", err);
    return NextResponse.json({ error: "lookup failed" }, { status: 500 });
  }
}
