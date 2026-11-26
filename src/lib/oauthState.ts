import { randomBytes } from "node:crypto";
import { safeEqual } from "@/lib/safeEqual";

// Ties an OAuth callback to the browser that started it. Without this, anyone can run
// Google's consent flow with their own account, then get the OWNER to open
// /api/auth/google/callback?code=<that code>. The owner's session cookie rides along, the
// app swaps the stored Gmail refresh token for the attacker's, and the dashboard and the
// Telegram bot then show the attacker's mail.
//
// The start route sets a short-lived cookie holding a random `state` and the PKCE code
// verifier. The callback accepts a code only when the `state` in the URL matches the
// cookie, and sends the verifier along so Google checks it too.

export const GMAIL_CONNECT_COOKIE = "gmail_connect";

const COOKIE_MAX_AGE_SECONDS = 10 * 60;

export function newOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

// base64url has no '.', so the first '.' always ends the state. The verifier may use '.'.
export function packOAuthCookie(state: string, codeVerifier: string): string {
  return `${state}.${codeVerifier}`;
}

// Returns the PKCE code verifier when the cookie carries exactly `stateParam`, else null.
export function unpackOAuthCookie(cookieValue: string | undefined, stateParam: string | null): string | null {
  if (!cookieValue || !stateParam) return null;

  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return null;

  const state = cookieValue.slice(0, dot);
  const codeVerifier = cookieValue.slice(dot + 1);
  if (!codeVerifier || !safeEqual(state, stateParam)) return null;

  return codeVerifier;
}

// The same protection for dashboard sign-in: a stolen or replayed login code cannot mint
// a session in a browser that did not start that sign-in.
export const LOGIN_COOKIE = "login_flow";

// Each flow's cookie is scoped to its own route prefix, so it is sent only to its start
// route and its callback.
export const GMAIL_CONNECT_PATH = "/api/auth/google";
export const LOGIN_PATH = "/api/auth/login";

export function oauthCookieOptions(path: string) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path,
  };
}
