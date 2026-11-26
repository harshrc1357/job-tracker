import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE_NAME } from "./session";

const cookieJar = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session" && cookieJar.value ? { name, value: cookieJar.value } : undefined),
  }),
}));

import { isOwnerRequest, requireOwner } from "./requireOwner";

const OWNER = "owner@example.com";

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret-with-enough-length-0123456789";
  process.env.OWNER_EMAIL = OWNER;
  cookieJar.value = undefined;
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.OWNER_EMAIL;
});

describe("requireOwner", () => {
  test("rejects a request with no session cookie", async () => {
    await expect(requireOwner()).rejects.toThrow("unauthorized");
  });

  test("rejects a valid session that belongs to someone else", async () => {
    cookieJar.value = await createSessionToken("stranger@example.com");
    await expect(requireOwner()).rejects.toThrow("unauthorized");
  });

  test("rejects a forged cookie", async () => {
    cookieJar.value = "eyJhbGciOiJIUzI1NiJ9.e30.forged";
    expect(await isOwnerRequest()).toBe(false);
  });

  test("accepts the owner's session", async () => {
    cookieJar.value = await createSessionToken(OWNER);
    await expect(requireOwner()).resolves.toBeUndefined();
    expect(SESSION_COOKIE_NAME).toBe("session");
  });
});
