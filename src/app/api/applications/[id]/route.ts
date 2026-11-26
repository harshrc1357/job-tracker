import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { applications } from "@/db/schema";
import { parseId } from "@/lib/parseId";
import { isOwnerRequest } from "@/lib/requireOwner";

// The full HTML body of one email, fetched when the user actually clicks it.
//
// It exists because the dashboard used to ship every column of every row, and
// bodyHtml was 87% of that payload (1863 kB of 2142 kB at 212 rows) to render one
// message nobody had opened yet. The list query now omits it and this route serves it
// one at a time.
//
// It checks the owner's session itself, as well as the middleware doing so: this route
// serves whole email bodies, so one mistake in the middleware matcher must not be enough
// to expose them.
export const runtime = "nodejs";

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!(await isOwnerRequest())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  // Parsed rather than passed through. Drizzle parameterises the query either way, so
  // this is about returning a clean 400 instead of a database type error.
  const numericId = parseId(id);
  if (numericId === null) {
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
