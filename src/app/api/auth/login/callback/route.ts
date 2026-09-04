import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE } from "@/lib/session";

export const runtime = "nodejs";

// No CSRF "state" check here on purpose: even if an attacker replayed a forged
// callback, the account still has to pass the OWNER_EMAIL check below. Only the
// real owner's Google account can ever produce a session — single-user allowlist,
// not a general login system.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(new URL("/login?error=oauth", req.url));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_LOGIN_REDIRECT_URI;
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!clientId || !clientSecret || !redirectUri || !ownerEmail) {
    return NextResponse.json(
      {
        error:
          "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_LOGIN_REDIRECT_URI / OWNER_EMAIL must be set",
      },
      { status: 500 }
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.id_token) {
    return NextResponse.redirect(new URL("/login?error=oauth", req.url));
  }

  const ticket = await oauth2Client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
  const payload = ticket.getPayload();
  const email = payload?.email;

  if (!email || !payload?.email_verified || email.toLowerCase() !== ownerEmail.toLowerCase()) {
    return NextResponse.redirect(new URL("/login?error=forbidden", req.url));
  }

  const token = await createSessionToken(email);
  const response = NextResponse.redirect(new URL("/", req.url));
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return response;
}
