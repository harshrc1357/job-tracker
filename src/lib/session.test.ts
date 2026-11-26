import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSessionToken, isOwnerSession, isSessionSecretUsable, verifySessionToken } from "./session";

const SECRET = "test-secret-with-enough-length-0123456789";
const OWNER = "Owner@Example.com";

const saved = { secret: process.env.SESSION_SECRET, owner: process.env.OWNER_EMAIL };

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.OWNER_EMAIL = OWNER;
});

afterEach(() => {
  if (saved.secret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = saved.secret;
  if (saved.owner === undefined) delete process.env.OWNER_EMAIL;
  else process.env.OWNER_EMAIL = saved.owner;
});

describe("verifySessionToken", () => {
  test("returns the email of a token this app signed", async () => {
    const token = await createSessionToken("a@example.com");
    expect(await verifySessionToken(token)).toBe("a@example.com");
  });

  test("returns null for a token signed with another secret", async () => {
    const forged = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("some-other-secret-entirely-0123456789"));
    expect(await verifySessionToken(forged)).toBeNull();
  });

  test("returns null for a token signed with an algorithm other than HS256", async () => {
    const hs512 = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: "HS512" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySessionToken(hs512)).toBeNull();
  });

  test("returns null for an expired token", async () => {
    const expired = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySessionToken(expired)).toBeNull();
  });

  test("returns null for garbage", async () => {
    expect(await verifySessionToken("not-a-token")).toBeNull();
  });
});

describe("isOwnerSession", () => {
  test("is true for a valid token carrying the owner's email, in any letter case", async () => {
    expect(await isOwnerSession(await createSessionToken("owner@example.COM"))).toBe(true);
  });

  test("is false for a valid token carrying someone else's email", async () => {
    expect(await isOwnerSession(await createSessionToken("stranger@example.com"))).toBe(false);
  });

  test.each([undefined, null, ""])("is false when the cookie is %p", async (token) => {
    expect(await isOwnerSession(token)).toBe(false);
  });

  test("is false when OWNER_EMAIL is not set, even for a valid token", async () => {
    const token = await createSessionToken(OWNER);
    delete process.env.OWNER_EMAIL;
    expect(await isOwnerSession(token)).toBe(false);
  });

  test("is false when SESSION_SECRET is not set", async () => {
    const token = await createSessionToken(OWNER);
    delete process.env.SESSION_SECRET;
    expect(await isOwnerSession(token)).toBe(false);
  });

  test("is false when SESSION_SECRET is shorter than 32 characters, even for a token signed with it", async () => {
    // Arrange: a token that the short secret signs is forgeable offline, so it must not count.
    const short = "dev-secret";
    const token = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(short));
    process.env.SESSION_SECRET = short;

    // Act + Assert
    expect(await isOwnerSession(token)).toBe(false);
  });
});

describe("isSessionSecretUsable", () => {
  test.each([
    [undefined, false],
    ["", false],
    ["x".repeat(31), false],
    ["x".repeat(32), true],
  ])("is %p -> %p", (secret, expected) => {
    if (secret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = secret;
    expect(isSessionSecretUsable()).toBe(expected);
  });
});

describe("createSessionToken", () => {
  test("refuses to sign with a SESSION_SECRET shorter than 32 characters", async () => {
    process.env.SESSION_SECRET = "dev";
    await expect(createSessionToken(OWNER)).rejects.toThrow(/at least 32/);
  });
});
