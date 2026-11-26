import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GMAIL_CONNECT_COOKIE, newOAuthState, packOAuthCookie } from "@/lib/oauthState";
import { readStoredToken } from "@/lib/tokenCrypto";

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  transaction: vi.fn(),
  getToken: vi.fn(),
  getProfile: vi.fn(),
}));

vi.mock("@/db/client", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/db/schema", () => ({ googleAuth: {} }));
vi.mock("@/lib/gmail", async () => {
  const { google } = await import("googleapis");
  return {
    getOAuthClient: () => {
      const client = new google.auth.OAuth2("client-id", "client-secret", "http://localhost:3000/api/auth/google/callback");
      client.getToken = mocks.getToken as never;
      return client;
    },
  };
});
vi.mock("googleapis", async (importOriginal) => {
  const original = await importOriginal<typeof import("googleapis")>();
  return {
    ...original,
    google: { ...original.google, gmail: () => ({ users: { getProfile: mocks.getProfile } }) },
  };
});

import { GET as start } from "./route";
import { GET as callback } from "./callback/route";

const OWNER = "owner@example.com";
const VERIFIER = "a-pkce-verifier";

function callbackRequest(query: string, cookie?: string) {
  return new NextRequest(`http://localhost:3000/api/auth/google/callback?${query}`, {
    headers: cookie ? { cookie: `${GMAIL_CONNECT_COOKIE}=${cookie}` } : {},
  });
}

beforeEach(() => {
  process.env.OWNER_EMAIL = OWNER;
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<void>) =>
    run({ delete: vi.fn(), insert: () => ({ values: mocks.insertValues }) })
  );
  mocks.getToken.mockResolvedValue({ tokens: { refresh_token: "refresh-1", access_token: "access-1" } });
  mocks.getProfile.mockResolvedValue({ data: { emailAddress: OWNER } });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.OWNER_EMAIL;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("GET /api/auth/google (start)", () => {
  test("sends Google a state and a PKCE challenge, and remembers both in a cookie", async () => {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/auth/google/callback";

    const response = await start();
    const location = new URL(response.headers.get("location") as string);
    const state = location.searchParams.get("state");

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(response.cookies.get(GMAIL_CONNECT_COOKIE)?.value.startsWith(`${state}.`)).toBe(true);
  });
});

describe("GET /api/auth/google/callback", () => {
  test("refuses a code that arrives with no cookie, and never touches Google or the database", async () => {
    const response = await callback(callbackRequest(`code=attacker-code&state=${newOAuthState()}`));

    expect(response.status).toBe(400);
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  test("refuses a code whose state is not the one in the cookie", async () => {
    const cookie = packOAuthCookie(newOAuthState(), VERIFIER);
    const response = await callback(callbackRequest(`code=c&state=${newOAuthState()}`, cookie));

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  test("refuses a callback with no state at all", async () => {
    const cookie = packOAuthCookie(newOAuthState(), VERIFIER);
    const response = await callback(callbackRequest("code=c", cookie));

    expect(response.status).toBe(400);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  test("does not store a token for a mailbox that is not the owner's", async () => {
    mocks.getProfile.mockResolvedValue({ data: { emailAddress: "attacker@example.com" } });
    const state = newOAuthState();
    const response = await callback(callbackRequest(`code=c&state=${state}`, packOAuthCookie(state, VERIFIER)));

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  test("stores the token for the owner's mailbox, sends the PKCE verifier, and clears the cookie", async () => {
    const state = newOAuthState();
    const response = await callback(callbackRequest(`code=good-code&state=${state}`, packOAuthCookie(state, VERIFIER)));

    expect(response.status).toBe(200);
    expect(mocks.getToken).toHaveBeenCalledWith({ code: "good-code", codeVerifier: VERIFIER });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(response.cookies.get(GMAIL_CONNECT_COOKIE)?.value).toBe("");
  });

  test("stores the refresh token encrypted, never as plaintext", async () => {
    const state = newOAuthState();
    await callback(callbackRequest(`code=good-code&state=${state}`, packOAuthCookie(state, VERIFIER)));

    const stored = mocks.insertValues.mock.calls[0][0].refreshToken as string;
    expect(stored).not.toContain("refresh-1");
    expect(readStoredToken(stored)).toEqual({ token: "refresh-1", needsReencrypt: false });
  });

  test("refuses to store the token when TOKEN_ENCRYPTION_KEY is missing", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = newOAuthState();
    const response = await callback(callbackRequest(`code=good-code&state=${state}`, packOAuthCookie(state, VERIFIER)));

    expect(response.status).toBe(500);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  test("answers with a clean 400 when Google refuses the code", async () => {
    mocks.getToken.mockRejectedValue(new Error("invalid_grant"));
    const state = newOAuthState();
    const response = await callback(callbackRequest(`code=bad&state=${state}`, packOAuthCookie(state, VERIFIER)));

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
