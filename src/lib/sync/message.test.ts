// Which failures count toward the retry limit (see retryLimit.ts). Only the classifier
// failing on this one email counts. A Gmail fault, a rate limit or every model being
// down says nothing about the email, so it must never move it closer to being given up.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { gmail_v1 } from "googleapis";
import { LlmError, LlmUnavailableError } from "@/lib/llm/errors";

const classifyEmail = vi.fn();
vi.mock("@/lib/classify", () => ({ classifyEmail: (...args: unknown[]) => classifyEmail(...args) }));

const { processMessage } = await import("./message");

const gmailReturning = (get: () => Promise<unknown>) =>
  ({ users: { messages: { get } } }) as unknown as gmail_v1.Gmail;

const okGmail = gmailReturning(async () => ({
  data: {
    id: "m1",
    threadId: "t1",
    internalDate: "1790000000000",
    snippet: "Thanks for applying",
    payload: { headers: [{ name: "Subject", value: "Your application" }, { name: "From", value: "jobs@acme.com" }] },
  },
}));

const budget = () => ({ remaining: 10, used: 0 });

beforeEach(() => {
  classifyEmail.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("processMessage failure outcomes", () => {
  test("an unusable model answer counts as a failed classification of this message", async () => {
    classifyEmail.mockRejectedValue(new LlmError("could not parse verdict", { kind: "unusable", model: "m" }));

    const outcome = await processMessage(okGmail, "m1", budget());

    expect(outcome).toMatchObject({ status: "classifyFailed", messageId: "m1" });
    expect(outcome.status === "classifyFailed" && outcome.message).toContain("could not parse verdict");
  });

  test("any other exception inside the classifier also counts", async () => {
    classifyEmail.mockRejectedValue(new TypeError("cannot read properties of undefined"));

    await expect(processMessage(okGmail, "m1", budget())).resolves.toMatchObject({ status: "classifyFailed" });
  });

  test("every model being unavailable is a plain error, never counted", async () => {
    const fatal = new LlmError("bad request", { kind: "fatal", model: "m", status: 400 });
    classifyEmail.mockRejectedValue(new LlmUnavailableError([fatal]));

    await expect(processMessage(okGmail, "m1", budget())).resolves.toMatchObject({ status: "error" });
  });

  test("a throttled provider is a rate limit, never counted", async () => {
    const throttled = new LlmError("slow down", { kind: "retryable", model: "m", status: 429 });
    classifyEmail.mockRejectedValue(new LlmUnavailableError([throttled]));

    await expect(processMessage(okGmail, "m1", budget())).resolves.toMatchObject({ status: "rateLimited" });
  });

  test("a Gmail failure before classification is a plain error, never counted", async () => {
    const gmail = gmailReturning(async () => {
      throw new Error("Gmail 503");
    });

    await expect(processMessage(gmail, "m1", budget())).resolves.toMatchObject({ status: "error" });
    expect(classifyEmail).not.toHaveBeenCalled();
  });
});
