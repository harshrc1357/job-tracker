import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// The Gmail refresh token is permanent read access to the owner's whole mailbox, so the
// database only ever holds it encrypted. The key lives in TOKEN_ENCRYPTION_KEY alone: a
// database URL, a Supabase dashboard login or a pg_dump file is no longer enough to read it.
//
// Stored format: "enc:v1:<iv>:<auth tag>:<ciphertext>", each part base64url. A Google
// refresh token never starts with "enc:", so a value without the prefix is a row saved
// before encryption existed.

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
// Binds each ciphertext to this one column, so it cannot be replayed as another secret.
const ASSOCIATED_DATA = Buffer.from("google_auth.refresh_token");

export interface StoredToken {
  token: string;
  // True for a legacy plaintext row: the caller re-saves it encrypted.
  needsReencrypt: boolean;
}

function getKey(): Buffer {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be set (32 random bytes, base64). See .env.example for the command that makes one."
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; it decodes to ${key.length}.`);
  }
  return key;
}

export function encryptToken(token: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv).setAAD(ASSOCIATED_DATA);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(":");
}

function decrypt(key: Buffer, body: string): string {
  const parts = body.split(":");
  if (parts.length !== 3) throw new Error("wrong number of parts");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv(ALGORITHM, key, iv).setAAD(ASSOCIATED_DATA);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// Fails closed: no key means no token, even for a plaintext row, so a missing env var is
// found on the first sync rather than after the token has sat in plaintext for months.
export function readStoredToken(stored: string): StoredToken {
  const key = getKey();
  if (!stored.startsWith(PREFIX)) {
    return { token: stored, needsReencrypt: true };
  }
  try {
    return { token: decrypt(key, stored.slice(PREFIX.length)), needsReencrypt: false };
  } catch {
    throw new Error(
      "The stored Gmail token could not be decrypted: TOKEN_ENCRYPTION_KEY is not the key it was saved with, " +
        "or the row was changed. Restore the old key, or reconnect Gmail at /api/auth/google."
    );
  }
}
