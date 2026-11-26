import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE } from "@/lib/session";
import { LOGIN_COOKIE, LOGIN_PATH, unpackOAuthCookie } from "@/lib/oauthState";

export const runtime = "nodejs";

// Every redirect clears the one-time cookie, so a state cannot be tried twice.
function redirectTo(path: string, req: NextRequest) {
  const response = NextResponse.redirect(new URL(path, req.url));
  response.cookies.delete({ name: LOGIN_COOKIE, path: LOGIN_PATH });
  return response;
}

// Two checks stand between a code and a session. The `state` and PKCE verifier tie the
// code to the browser that started the sign-in, so a stolen or replayed code is refused.
// The OWNER_EMAIL check below then lets only the owner's Google account in: a
// single-user allowlist, not a general login system.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (error || !code) {
    return redirectTo("/login?error=oauth", req);
  }

  const codeVerifier = unpackOAuthCookie(req.cookies.get(LOGIN_COOKIE)?.value, req.nextUrl.searchParams.get("state"));
  if (!codeVerifier) {
    return redirectTo("/login?error=oauth", req);
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

  // A bad or expired code, or a token that fails verification, is a failed sign-in for
  // the person to retry, not a server error.
  let email: string | undefined;
  let isEmailVerified = false;
  try {
    const { tokens } = await oauth2Client.getToken({ code, codeVerifier });
    if (!tokens.id_token) {
      return redirectTo("/login?error=oauth", req);
    }
    const ticket = await oauth2Client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
    const payload = ticket.getPayload();
    email = payload?.email;
    isEmailVerified = payload?.email_verified === true;
  } catch (err) {
    console.error("[login] Google sign-in failed", err instanceof Error ? err.message : String(err));
    return redirectTo("/login?error=oauth", req);
  }

  if (!email || !isEmailVerified || email.toLowerCase() !== ownerEmail.toLowerCase()) {
    return redirectTo("/login?error=forbidden", req);
  }

  const token = await createSessionToken(email);
  const response = redirectTo("/", req);
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return response;
}
