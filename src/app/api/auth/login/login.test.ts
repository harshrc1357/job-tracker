import { NextRequest } from "next/server";
import { google } from "googleapis";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LOGIN_COOKIE, newOAuthState, packOAuthCookie } from "@/lib/oauthState";
import { SESSION_COOKIE_NAME } from "@/lib/session";
import { GET as start } from "./route";
import { GET as callback } from "./callback/route";

const OWNER = "owner@example.com";
const VERIFIER = "a-pkce-verifier";

const getToken = vi.spyOn(google.auth.OAuth2.prototype, "getToken");
const verifyIdToken = vi.spyOn(google.auth.OAuth2.prototype, "verifyIdToken");

function callbackRequest(query: string, cookie?: string) {
  return new NextRequest(`http://localhost:3000/api/auth/login/callback?${query}`, {
    headers: cookie ? { cookie: `${LOGIN_COOKIE}=${cookie}` } : {},
  });
}

function signedInAs(email: string) {
  getToken.mockResolvedValue({ tokens: { id_token: "id-token" }, res: null } as never);
  verifyIdToken.mockResolvedValue({ getPayload: () => ({ email, email_verified: true }) } as never);
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_LOGIN_REDIRECT_URI = "http://localhost:3000/api/auth/login/callback";
  process.env.OWNER_EMAIL = OWNER;
  process.env.SESSION_SECRET = "test-secret-with-enough-length-0123456789";
  signedInAs(OWNER);
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.OWNER_EMAIL;
  delete process.env.SESSION_SECRET;
});

describe("GET /api/auth/login (start)", () => {
  test("sends Google a state and a PKCE challenge, and remembers both in a cookie", async () => {
    const response = await start();
    const location = new URL(response.headers.get("location") as string);
    const state = location.searchParams.get("state");

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(response.cookies.get(LOGIN_COOKIE)?.value.startsWith(`${state}.`)).toBe(true);
  });
});

describe("GET /api/auth/login/callback", () => {
  test("refuses a code that arrives with no cookie, and never asks Google", async () => {
    const response = await callback(callbackRequest(`code=stolen-code&state=${newOAuthState()}`));

    expect(new URL(response.headers.get("location") as string).search).toBe("?error=oauth");
    expect(getToken).not.toHaveBeenCalled();
    expect(response.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  test("refuses a code whose state is not the one in the cookie", async () => {
    const cookie = packOAuthCookie(newOAuthState(), VERIFIER);
    const response = await callback(callbackRequest(`code=c&state=${newOAuthState()}`, cookie));

    expect(new URL(response.headers.get("location") as string).search).toBe("?error=oauth");
    expect(getToken).not.toHaveBeenCalled();
  });

  test("signs the owner in, sends the PKCE verifier, and clears the one-time cookie", async () => {
    const state = newOAuthState();
    const response = await callback(callbackRequest(`code=c&state=${state}`, packOAuthCookie(state, VERIFIER)));

    expect(getToken).toHaveBeenCalledWith({ code: "c", codeVerifier: VERIFIER });
    expect(new URL(response.headers.get("location") as string).pathname).toBe("/");
    expect(response.cookies.get(SESSION_COOKIE_NAME)?.value).toBeTruthy();
    expect(response.cookies.get(LOGIN_COOKIE)?.value).toBe("");
  });

  test("sends someone else's Google account back to /login with forbidden", async () => {
    signedInAs("stranger@example.com");
    const state = newOAuthState();
    const response = await callback(callbackRequest(`code=c&state=${state}`, packOAuthCookie(state, VERIFIER)));

    expect(new URL(response.headers.get("location") as string).search).toBe("?error=forbidden");
    expect(response.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  test("turns a code Google refuses into /login?error=oauth, not a 500", async () => {
    getToken.mockRejectedValue(new Error("invalid_grant"));
    const state = newOAuthState();
    const response = await callback(callbackRequest(`code=bad&state=${state}`, packOAuthCookie(state, VERIFIER)));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") as string).search).toBe("?error=oauth");
  });

  test("turns an ID token that fails verification into /login?error=oauth, not a 500", async () => {
    verifyIdToken.mockRejectedValue(new Error("Wrong recipient"));
    const state = newOAuthState();
    const response = await callback(callbackRequest(`code=c&state=${state}`, packOAuthCookie(state, VERIFIER)));

    expect(new URL(response.headers.get("location") as string).search).toBe("?error=oauth");
  });
});
