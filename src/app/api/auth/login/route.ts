import { NextResponse } from "next/server";
import { Auth, google } from "googleapis";
import { LOGIN_COOKIE, LOGIN_PATH, newOAuthState, oauthCookieOptions, packOAuthCookie } from "@/lib/oauthState";

export const runtime = "nodejs";

// Starts "sign in with Google" for the dashboard itself. This is separate from
// /api/auth/google, which grants the app read access to Gmail — this route only
// proves who is signing in, using the openid/email scopes and its own redirect URI.
//
// Like the Gmail connect flow, it hands Google a random `state` and a PKCE challenge and
// remembers both in a cookie, so the callback accepts only a code this browser asked for.
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
  const { codeVerifier, codeChallenge } = await oauth2Client.generateCodeVerifierAsync();
  const state = newOAuthState();

  const url = oauth2Client.generateAuthUrl({
    scope: ["openid", "email"],
    prompt: "select_account",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: Auth.CodeChallengeMethod.S256,
  });

  const response = NextResponse.redirect(url);
  response.cookies.set(LOGIN_COOKIE, packOAuthCookie(state, codeVerifier as string), oauthCookieOptions(LOGIN_PATH));
  return response;
}
