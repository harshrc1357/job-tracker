import { NextResponse } from "next/server";
import { Auth } from "googleapis";
import { getOAuthClient } from "@/lib/gmail";
import {
  GMAIL_CONNECT_COOKIE,
  GMAIL_CONNECT_PATH,
  newOAuthState,
  oauthCookieOptions,
  packOAuthCookie,
} from "@/lib/oauthState";

export const runtime = "nodejs";

// Visit this route once in a browser (as yourself) to grant the app read-only Gmail
// access. Not linked from the UI on purpose — it's a one-time setup step, not something
// meant to be clicked repeatedly.
//
// It hands Google a random `state` and a PKCE challenge, and remembers both in a cookie,
// so the callback can refuse a code that this browser did not ask for.
export async function GET() {
  const oauth2Client = getOAuthClient();
  const { codeVerifier, codeChallenge } = await oauth2Client.generateCodeVerifierAsync();
  const state = newOAuthState();

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: Auth.CodeChallengeMethod.S256,
  });

  const response = NextResponse.redirect(url);
  response.cookies.set(GMAIL_CONNECT_COOKIE, packOAuthCookie(state, codeVerifier as string), oauthCookieOptions(GMAIL_CONNECT_PATH));
  return response;
}
