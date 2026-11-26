import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { encryptToken, readStoredToken } from "./tokenCrypto";

const mocks = vi.hoisted(() => ({
  rows: [] as { id: number; refreshToken: string }[],
  updateSet: vi.fn(),
  setCredentials: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({ from: () => ({ limit: async () => mocks.rows }) }),
    update: () => ({ set: (values: unknown) => ({ where: async () => mocks.updateSet(values) }) }),
  },
}));
vi.mock("@/db/schema", () => ({ googleAuth: { id: "id" } }));
vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: class { setCredentials = mocks.setCredentials; } },
    gmail: () => ({}),
  },
}));

const { getGmailClient } = await import("./gmail");

const TOKEN = "1//0gExampleRefreshToken";

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/auth/google/callback";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("getGmailClient", () => {
  test("decrypts an encrypted row and does not rewrite it", async () => {
    mocks.rows = [{ id: 1, refreshToken: encryptToken(TOKEN) }];

    await getGmailClient();

    expect(mocks.setCredentials).toHaveBeenCalledWith({ refresh_token: TOKEN });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  test("uses a legacy plaintext row and re-saves it encrypted", async () => {
    mocks.rows = [{ id: 1, refreshToken: TOKEN }];

    await getGmailClient();

    expect(mocks.setCredentials).toHaveBeenCalledWith({ refresh_token: TOKEN });
    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    const saved = mocks.updateSet.mock.calls[0][0].refreshToken as string;
    expect(saved).not.toContain(TOKEN);
    expect(readStoredToken(saved)).toEqual({ token: TOKEN, needsReencrypt: false });
  });

  test("still syncs when the re-save of a plaintext row fails", async () => {
    mocks.rows = [{ id: 1, refreshToken: TOKEN }];
    mocks.updateSet.mockRejectedValueOnce(new Error("db down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await getGmailClient();

    expect(mocks.setCredentials).toHaveBeenCalledWith({ refresh_token: TOKEN });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  test("fails closed when the key is missing", async () => {
    mocks.rows = [{ id: 1, refreshToken: TOKEN }];
    delete process.env.TOKEN_ENCRYPTION_KEY;

    await expect(getGmailClient()).rejects.toThrow(/TOKEN_ENCRYPTION_KEY must be set/);
    expect(mocks.setCredentials).not.toHaveBeenCalled();
  });
});
