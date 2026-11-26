import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSessionToken } from "@/lib/session";

const mocks = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  setStage: vi.fn(),
  detachEmail: vi.fn(),
  splitApplication: vi.fn(),
  mergeApplications: vi.fn(),
  resolveReview: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session" && mocks.cookie ? { name, value: mocks.cookie } : undefined),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/lib/link/actions", () => ({
  setStage: mocks.setStage,
  detachEmail: mocks.detachEmail,
  splitApplication: mocks.splitApplication,
  mergeApplications: mocks.mergeApplications,
  resolveReview: mocks.resolveReview,
}));

import {
  detachEmailAction,
  mergeAction,
  resolveReviewAction,
  setStageAction,
  splitAction,
} from "./actions";

const OWNER = "owner@example.com";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

// One valid form per action, so a test can prove that the owner check, and nothing else,
// is what stops a call.
const CALLS: [string, () => Promise<void>][] = [
  ["setStageAction", () => setStageAction(form({ appId: "1", stage: "Rejected" }))],
  ["detachEmailAction", () => detachEmailAction(form({ appId: "1", emailId: "2" }))],
  ["splitAction", () => splitAction(form({ appId: "1", emailId: "2" }))],
  ["mergeAction", () => mergeAction(form({ appId: "1", intoId: "2" }))],
  ["resolveReviewAction", () => resolveReviewAction(form({ itemId: "1", choice: "ignore" }))],
];

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret-with-enough-length-0123456789";
  process.env.OWNER_EMAIL = OWNER;
  mocks.cookie = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.SESSION_SECRET;
  delete process.env.OWNER_EMAIL;
});

const writes = () =>
  [mocks.setStage, mocks.detachEmail, mocks.splitApplication, mocks.mergeApplications, mocks.resolveReview].reduce(
    (total, fn) => total + fn.mock.calls.length,
    0
  );

describe("server actions", () => {
  test.each(CALLS)("%s rejects a caller with no session and writes nothing", async (_name, call) => {
    await expect(call()).rejects.toThrow("unauthorized");
    expect(writes()).toBe(0);
  });

  test.each(CALLS)("%s rejects a session that is not the owner's", async (_name, call) => {
    mocks.cookie = await createSessionToken("stranger@example.com");
    await expect(call()).rejects.toThrow("unauthorized");
    expect(writes()).toBe(0);
  });

  test.each(CALLS)("%s runs for the owner", async (_name, call) => {
    mocks.cookie = await createSessionToken(OWNER);
    mocks.splitApplication.mockResolvedValue(3);
    await call();
    expect(writes()).toBe(1);
  });

  test("splitAction refuses a role longer than 200 characters and more than 500 email ids", async () => {
    mocks.cookie = await createSessionToken(OWNER);

    const longRole = form({ appId: "1", emailId: "2", role: "r".repeat(201) });
    await expect(splitAction(longRole)).rejects.toThrow("bad role");

    const manyIds = form({ appId: "1" });
    for (let i = 1; i <= 501; i++) manyIds.append("emailId", String(i));
    await expect(splitAction(manyIds)).rejects.toThrow("too many emails");

    expect(writes()).toBe(0);
  });

  test.each(["1e3", "0x10", "-5", "0", "99999999999"])("rejects the id %s from the owner", async (appId) => {
    mocks.cookie = await createSessionToken(OWNER);
    await expect(setStageAction(form({ appId, stage: "Rejected" }))).rejects.toThrow("bad id");
    expect(writes()).toBe(0);
  });
});
