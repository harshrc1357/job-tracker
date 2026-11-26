import { describe, expect, test } from "vitest";
import { newOAuthState, packOAuthCookie, unpackOAuthCookie } from "./oauthState";

describe("newOAuthState", () => {
  test("is long, URL-safe and different each time", () => {
    const a = newOAuthState();
    const b = newOAuthState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("unpackOAuthCookie", () => {
  const verifier = "verifier-with.dots_and-dashes~123";

  test("returns the PKCE verifier when the state in the URL matches the cookie", () => {
    const state = newOAuthState();
    expect(unpackOAuthCookie(packOAuthCookie(state, verifier), state)).toBe(verifier);
  });

  test("returns null when the state in the URL is not the one in the cookie", () => {
    const cookie = packOAuthCookie(newOAuthState(), verifier);
    expect(unpackOAuthCookie(cookie, newOAuthState())).toBeNull();
  });

  test("returns null when the cookie is missing", () => {
    expect(unpackOAuthCookie(undefined, newOAuthState())).toBeNull();
  });

  test("returns null when the URL has no state, so a forged callback link is refused", () => {
    expect(unpackOAuthCookie(packOAuthCookie(newOAuthState(), verifier), null)).toBeNull();
  });

  test.each(["", "no-dot-here", ".only-verifier", "state."])("returns null for the malformed cookie %p", (cookie) => {
    expect(unpackOAuthCookie(cookie, "state")).toBeNull();
  });
});
