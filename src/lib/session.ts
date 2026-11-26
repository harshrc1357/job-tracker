import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, in seconds

// Signing and verifying name the same algorithm, so a token cannot choose a different one.
const SESSION_ALGORITHM = "HS256";

// A shorter HMAC secret can be guessed offline from one stolen cookie, and the guess then
// signs a session for anyone. Below this length the app refuses to sign or accept a token.
export const MIN_SESSION_SECRET_LENGTH = 32;

export function isSessionSecretUsable(): boolean {
  const secret = process.env.SESSION_SECRET;
  return secret !== undefined && secret.length >= MIN_SESSION_SECRET_LENGTH;
}

function getSecretKey() {
  if (!isSessionSecretUsable()) {
    throw new Error(`SESSION_SECRET must be set, with at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  }
  return new TextEncoder().encode(process.env.SESSION_SECRET);
}

export async function createSessionToken(email: string) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: SESSION_ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSecretKey());
}

// Returns the signed-in email, or null if the token is missing, expired, or tampered with.
export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: [SESSION_ALGORITHM] });
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

// True only for a valid session whose email is OWNER_EMAIL. The one definition of "this
// request is the owner", shared by the middleware and by requireOwner(), so the two
// cannot drift apart. Fails closed: a missing cookie, secret or OWNER_EMAIL is false.
export async function isOwnerSession(token: string | null | undefined): Promise<boolean> {
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!token || !ownerEmail) return false;

  const email = await verifySessionToken(token);
  return email !== null && email.toLowerCase() === ownerEmail.toLowerCase();
}
