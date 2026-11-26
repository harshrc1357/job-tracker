import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { encryptToken, readStoredToken } from "./tokenCrypto";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const TOKEN = "1//0gExampleRefreshToken-abc_123";

const saved = process.env.TOKEN_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
});

afterEach(() => {
  if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = saved;
});

// Flips one bit of the base64 segment at `index` in an "enc:v1:iv:tag:ciphertext" value.
function flipBit(stored: string, index: number) {
  const parts = stored.split(":");
  const bytes = Buffer.from(parts[index], "base64url");
  bytes[0] ^= 1;
  return [...parts.slice(0, index), bytes.toString("base64url"), ...parts.slice(index + 1)].join(":");
}

describe("encryptToken / readStoredToken", () => {
  test("round trip returns the original token and asks for no re-save", () => {
    const stored = encryptToken(TOKEN);

    expect(stored).not.toContain(TOKEN);
    expect(readStoredToken(stored)).toEqual({ token: TOKEN, needsReencrypt: false });
  });

  test("encrypting the same token twice gives different values (fresh IV)", () => {
    expect(encryptToken(TOKEN)).not.toBe(encryptToken(TOKEN));
  });

  test("throws when the value was encrypted with another key", () => {
    const stored = encryptToken(TOKEN);
    process.env.TOKEN_ENCRYPTION_KEY = OTHER_KEY;

    expect(() => readStoredToken(stored)).toThrow(/could not be decrypted/);
  });

  test("throws when the ciphertext was tampered with", () => {
    const stored = encryptToken(TOKEN);
    expect(() => readStoredToken(flipBit(stored, 4))).toThrow(/could not be decrypted/);
  });

  test("throws when the auth tag was tampered with", () => {
    const stored = encryptToken(TOKEN);
    expect(() => readStoredToken(flipBit(stored, 3))).toThrow(/could not be decrypted/);
  });

  test("throws on an encrypted value with the wrong number of parts", () => {
    expect(() => readStoredToken("enc:v1:abc")).toThrow(/could not be decrypted/);
  });

  test("accepts a legacy plaintext token once and asks for it to be re-saved encrypted", () => {
    expect(readStoredToken(TOKEN)).toEqual({ token: TOKEN, needsReencrypt: true });
  });
});

describe("TOKEN_ENCRYPTION_KEY", () => {
  test("encrypting fails closed when the key is missing", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken(TOKEN)).toThrow(/TOKEN_ENCRYPTION_KEY must be set/);
  });

  test("reading fails closed when the key is missing, even for a plaintext row", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => readStoredToken(TOKEN)).toThrow(/TOKEN_ENCRYPTION_KEY must be set/);
  });

  test("rejects a key that is not 32 bytes", () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect(() => encryptToken(TOKEN)).toThrow(/32 bytes/);
  });
});
