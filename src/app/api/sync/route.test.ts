import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimSyncSlot: vi.fn(),
  getGmailClient: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/lib/syncClaim", () => ({ claimSyncSlot: mocks.claimSyncSlot }));
// The run stops at the Gmail call: enough to see whether the sync started at all.
vi.mock("@/lib/gmail", () => ({ getGmailClient: mocks.getGmailClient }));
vi.mock("@/lib/llm/dailyUsage", () => ({
  loadDailyUsage: vi.fn(async () => ({})),
  ownerDayKey: () => "2026-10-23",
  recordDailyUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/llm/runtime", () => ({
  getQuota: () => ({ deltas: () => ({}), clearDeltas: () => {} }),
  setQuota: vi.fn(),
}));
vi.mock("@/lib/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telegram")>()),
  sendTelegramMessage: mocks.send,
  trySendTelegramMessage: mocks.send,
}));
vi.mock("@/db/client", () => ({ db: {} }));

import { GET, HEAD } from "./route";

const SECRET = "cron-secret-for-tests";

function request(isTrusted: boolean) {
  return new NextRequest("http://localhost:3000/api/sync", {
    headers: isTrusted ? { authorization: `Bearer ${SECRET}` } : {},
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  mocks.getGmailClient.mockRejectedValue(new Error("stop here"));
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
});

describe("GET /api/sync when the claim row cannot be written", () => {
  test("a caller without the secret gets {ok:true} and no run, so a flood cannot bypass the throttle", async () => {
    mocks.claimSyncSlot.mockResolvedValue({ claimed: false, reason: "error", message: "pooler full" });

    const response = await GET(request(false));

    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.getGmailClient).not.toHaveBeenCalled();
  });

  test("the cron, which holds the secret, still runs the sync", async () => {
    mocks.claimSyncSlot.mockResolvedValue({ claimed: false, reason: "error", message: "pooler full" });

    await GET(request(true));

    expect(mocks.getGmailClient).toHaveBeenCalledOnce();
  });
});

describe("HEAD /api/sync", () => {
  test("answers without starting a sync or touching the database", async () => {
    const response = await HEAD();

    expect(response.status).toBe(200);
    expect(mocks.claimSyncSlot).not.toHaveBeenCalled();
  });
});

describe("the Telegram alert", () => {
  test("clips each error line, so one long error cannot push the alert over Telegram's limit", async () => {
    mocks.claimSyncSlot.mockResolvedValue({ claimed: true });
    mocks.getGmailClient.mockRejectedValue(new Error("x".repeat(10_000)));

    await GET(request(true));

    const alert = mocks.send.mock.calls[0][0] as string;
    expect(alert.length).toBeLessThan(4096);
  });
});
