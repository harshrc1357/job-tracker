import { eq } from "drizzle-orm";
import { google } from "googleapis";
import { db } from "@/db/client";
import { googleAuth } from "@/db/schema";
import { encryptToken, readStoredToken } from "@/lib/tokenCrypto";

export function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI must be set");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// One Gmail account per deployment, kept in a single-row table rather than .env,
// since the refresh token is only produced after the OAuth consent screen runs once.
export async function getGmailClient() {
  const [row] = await db.select().from(googleAuth).limit(1);
  if (!row) {
    throw new Error("Gmail isn't connected yet — open /api/auth/google in a browser once to authorize it.");
  }

  const { token, needsReencrypt } = readStoredToken(row.refreshToken);
  if (needsReencrypt) {
    await reencryptRow(row.id, token);
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: token });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

// A row saved before encryption existed is accepted once and rewritten encrypted. A failed
// rewrite does not stop the sync: the next call tries again.
async function reencryptRow(id: number, token: string) {
  try {
    await db.update(googleAuth).set({ refreshToken: encryptToken(token) }).where(eq(googleAuth.id, id));
  } catch (err) {
    console.error("[gmail] could not re-save the plaintext refresh token encrypted; will retry next sync", err);
  }
}
