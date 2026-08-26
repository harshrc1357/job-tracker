import { NextRequest, NextResponse } from "next/server";
import { getOAuthClient } from "@/lib/gmail";
import { db } from "@/db/client";
import { googleAuth } from "@/db/schema";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ error: "missing code param" }, { status: 400 });
  }

  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    return NextResponse.json(
      {
        error:
          "Google didn't return a refresh token. This usually means the account already granted access once. " +
          "Revoke it at https://myaccount.google.com/permissions and try /api/auth/google again.",
      },
      { status: 400 }
    );
  }

  // Single-user app: replace whatever's there rather than accumulating rows.
  await db.delete(googleAuth);
  await db.insert(googleAuth).values({ refreshToken: tokens.refresh_token });

  return NextResponse.json({ ok: true, message: "Gmail connected. You can close this tab." });
}
