import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSessionToken } from "@/lib/session";

const mocks = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  select: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session" && mocks.cookie ? { name, value: mocks.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mocks.select }) }) }),
  },
}));

import { GET } from "./route";

const OWNER = "owner@example.com";
const call = (id: string) =>
  GET(new NextRequest(`http://localhost/api/applications/${id}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret-with-enough-length-0123456789";
  process.env.OWNER_EMAIL = OWNER;
  mocks.cookie = undefined;
  mocks.select.mockResolvedValue([{ body: "hello", bodyHtml: "<p>hello</p>" }]);
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.SESSION_SECRET;
  delete process.env.OWNER_EMAIL;
});

describe("GET /api/applications/[id]", () => {
  test("answers 401 without a session and never reads the database", async () => {
    const response = await call("1");

    expect(response.status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  test("answers 401 for a valid session that is not the owner's", async () => {
    mocks.cookie = await createSessionToken("stranger@example.com");
    expect((await call("1")).status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  test("returns the email body to the owner", async () => {
    mocks.cookie = await createSessionToken(OWNER);
    const response = await call("1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: "hello", bodyHtml: "<p>hello</p>" });
  });

  test.each(["1e3", "0x10", "0", "-1", "abc", "99999999999"])("answers 400 for the id %s", async (id) => {
    mocks.cookie = await createSessionToken(OWNER);
    expect((await call(id)).status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  test("answers 404 when no such email exists", async () => {
    mocks.cookie = await createSessionToken(OWNER);
    mocks.select.mockResolvedValue([]);
    expect((await call("7")).status).toBe(404);
  });
});
