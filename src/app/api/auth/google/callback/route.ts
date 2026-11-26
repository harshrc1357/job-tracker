import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { getOAuthClient } from "@/lib/gmail";
import { db } from "@/db/client";
import { googleAuth } from "@/db/schema";
import { GMAIL_CONNECT_COOKIE, GMAIL_CONNECT_PATH, unpackOAuthCookie } from "@/lib/oauthState";
import { encryptToken } from "@/lib/tokenCrypto";

export const runtime = "nodejs";

// Every reply clears the one-time cookie, so a state cannot be tried twice.
function reply(body: Record<string, unknown>, status: number) {
  const response = NextResponse.json(body, { status });
  response.cookies.delete({ name: GMAIL_CONNECT_COOKIE, path: GMAIL_CONNECT_PATH });
  return response;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    return reply({ error: "Google reported an error. Start again at /api/auth/google." }, 400);
  }
  if (!code) {
    return reply({ error: "missing code param" }, 400);
  }

  // Refuse a code this browser did not ask for. A link that carries someone else's code
  // has no matching cookie, so it can never replace the stored Gmail connection.
  const codeVerifier = unpackOAuthCookie(
    req.cookies.get(GMAIL_CONNECT_COOKIE)?.value,
    req.nextUrl.searchParams.get("state")
  );
  if (!codeVerifier) {
    return reply({ error: "This sign-in did not start here, or it expired. Start again at /api/auth/google." }, 400);
  }

  const ownerEmail = process.env.OWNER_EMAIL;
  if (!ownerEmail) {
    return reply({ error: "OWNER_EMAIL must be set" }, 500);
  }

  const oauth2Client = getOAuthClient();

  let tokens;
  try {
    ({ tokens } = await oauth2Client.getToken({ code, codeVerifier }));
  } catch (err) {
    console.error("[gmail-connect] code exchange failed", err);
    return reply({ error: "Google refused the code. Start again at /api/auth/google." }, 400);
  }

  if (!tokens.refresh_token) {
    return reply(
      {
        error:
          "Google didn't return a refresh token. This usually means the account already granted access once. " +
          "Revoke it at https://myaccount.google.com/permissions and try /api/auth/google again.",
      },
      400
    );
  }

  // Store the token only for the owner's own mailbox, whoever completed the flow.
  oauth2Client.setCredentials(tokens);
  let mailbox: string | null | undefined;
  try {
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    mailbox = (await gmail.users.getProfile({ userId: "me" })).data.emailAddress;
  } catch (err) {
    console.error("[gmail-connect] profile lookup failed", err);
    return reply({ error: "Could not confirm which mailbox this is. Start again at /api/auth/google." }, 502);
  }
  if (mailbox?.toLowerCase() !== ownerEmail.toLowerCase()) {
    return reply({ error: "That Gmail account is not the owner's mailbox, so it was not connected." }, 403);
  }

  // Single-user app: replace whatever's there rather than accumulating rows. One
  // transaction, so a failed insert cannot leave the app with no connection at all.
  let refreshToken: string;
  try {
    refreshToken = encryptToken(tokens.refresh_token);
  } catch (err) {
    console.error("[gmail-connect] could not encrypt the token", err);
    return reply({ error: "TOKEN_ENCRYPTION_KEY is missing or invalid on the server, so Gmail was not connected." }, 500);
  }
  try {
    await db.transaction(async (tx) => {
      await tx.delete(googleAuth);
      await tx.insert(googleAuth).values({ refreshToken });
    });
  } catch (err) {
    console.error("[gmail-connect] could not store the token", err);
    return reply({ error: "Could not save the Gmail connection. Try again." }, 500);
  }

  return reply({ ok: true, message: "Gmail connected. You can close this tab." }, 200);
}
