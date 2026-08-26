import { NextResponse } from "next/server";
import { getOAuthClient } from "@/lib/gmail";

export const runtime = "nodejs";

// Visit this route once in a browser (as yourself) to grant the app read-only Gmail
// access. Not linked from the UI on purpose — it's a one-time setup step, not something
// meant to be clicked repeatedly.
export async function GET() {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
  });
  return NextResponse.redirect(url);
}
