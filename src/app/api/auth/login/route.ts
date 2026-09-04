import { NextResponse } from "next/server";
import { google } from "googleapis";

export const runtime = "nodejs";

// Starts "sign in with Google" for the dashboard itself. This is separate from
// /api/auth/google, which grants the app read access to Gmail — this route only
// proves who is signing in, using the openid/email scopes and its own redirect URI.
export async function GET() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_LOGIN_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.json(
      { error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_LOGIN_REDIRECT_URI must be set" },
      { status: 500 }
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const url = oauth2Client.generateAuthUrl({
    scope: ["openid", "email"],
    prompt: "select_account",
  });
  return NextResponse.redirect(url);
}
