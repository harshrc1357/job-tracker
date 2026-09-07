import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { classifyEmail, type ClassifiableEmail } from "./index";
import { LlmUnavailableError } from "@/lib/llm/errors";
import { PRIMARY_MODEL } from "@/lib/llm/models";
import { resetRuntimeForTests } from "@/lib/llm/runtime";

// End-to-end over the two stages, with the network stubbed. What these pin down is
// the contract sync/route.ts depends on: exactly three outcomes, and "the model was
// unreachable" is never one of the two that get written to the database.

const email = (overrides: Partial<ClassifiableEmail> = {}): ClassifiableEmail => ({
  subject: "Thank you for your application",
  from: "Acme Careers <careers@acme.com>",
  to: "elon@example.com",
  cc: "",
  body: "We have received your application.",
  snippet: "We have received your application.",
  headers: {},
  ...overrides,
});

const answer = (verdict: Record<string, unknown>) =>
  new Response(
    JSON.stringify({
      model: PRIMARY_MODEL.id,
      choices: [{ message: { content: JSON.stringify(verdict) } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetRuntimeForTests();
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OWNER_EMAIL = "elon@example.com";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const promptOf = (call: unknown[]): string =>
  JSON.parse(String((call[1] as RequestInit).body)).messages[1].content;

describe("classifyEmail", () => {
  test("rejects a bulk job digest for free, without spending a call", async () => {
    // Arrange: the single biggest source of inbox noise, and the cheapest to kill.
    const input = email({
      from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>",
      subject: "9 new jobs for you",
    });

    // Act
    const result = await classifyEmail(input);

    // Assert
    expect(result).toEqual({
      decision: "skip",
      reason: expect.stringContaining("bulk job-alert sender"),
      source: "prefilter",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not charge the budget for a message the prefilter rejects for free", async () => {
    // Arrange: a run reported hitting an 80-call budget after 26 real calls, because
    // the other 54 were prefilter rejections charged anyway. The backlog drained at a
    // third of the rate it should have.
    let reserved = 0;
    const budget = { tryReserve: () => (reserved++, true) };

    // Act
    const result = await classifyEmail(
      email({ from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", subject: "9 new jobs for you" }),
      budget
    );

    // Assert
    expect(result.decision).toBe("skip");
    expect(reserved).toBe(0);
  });

  test("charges the budget exactly once for a message that needs the model", async () => {
    // Arrange
    fetchMock.mockResolvedValueOnce(answer({ isJob: true, category: "Applied", evidence: "received" }));
    let reserved = 0;
    const budget = { tryReserve: () => (reserved++, true) };

    // Act
    await classifyEmail(email(), budget);

    // Assert
    expect(reserved).toBe(1);
  });

  test("defers without deciding anything when the budget is spent", async () => {
    // Arrange: a deferred message must be left completely untouched. Recording it as
    // a skip would bank a decision the classifier never made.
    const result = await classifyEmail(email(), { tryReserve: () => false });

    // Assert
    expect(result).toEqual({ decision: "deferred" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sends the whole body to the model, not just the subject and snippet", async () => {
    // Arrange: this is the fix for the expensive failure. The subject says Applied,
    // the assessment is 400 characters down, and the old keyword pass returned before
    // anything read that far.
    fetchMock.mockResolvedValueOnce(
      answer({ isJob: true, category: "Assessment", evidence: "complete the online assessment" })
    );
    const input = email({
      subject: "Thank you for your application to Acme",
      snippet: "Dear candidate, thank you for your interest in Acme.",
      body: `Dear candidate, thank you for your interest in Acme.\n${"Boilerplate paragraph. ".repeat(20)}\nNext step: complete the online assessment by Friday 5pm.`,
    });

    // Act
    const result = await classifyEmail(input);

    // Assert
    expect(promptOf(fetchMock.mock.calls[0])).toContain("complete the online assessment by Friday 5pm");
    expect(result).toMatchObject({ decision: "store", category: "Assessment" });
  });

  test("banks a promotional email as a skip, never as a pipeline category", async () => {
    // Arrange: promo mail that survives the prefilter (no alert sender, no digest
    // subject) but is still an advert. The model answers the job question first, and
    // a "no" carries no category at all — there is nothing for it to be filed under.
    fetchMock.mockResolvedValueOnce(answer({ isJob: false, reason: "invitation to apply" }));

    // Act
    const result = await classifyEmail(
      email({
        subject: "This Senior Engineer role matches your profile",
        body: "We think you would be a great fit. Apply now.",
        headers: { "list-unsubscribe": "<mailto:unsub@board.com>" },
      })
    );

    // Assert
    expect(result).toEqual({ decision: "skip", reason: "invitation to apply", source: "llm" });
  });

  test("passes bulk headers to the model as a hint rather than acting on them", async () => {
    // Arrange: recruiters replying in a live thread send through platforms that set
    // List-Unsubscribe. Rejecting on it would drop real interview invites.
    fetchMock.mockResolvedValueOnce(answer({ isJob: true, category: "Interview", evidence: "book a time" }));

    // Act
    const result = await classifyEmail(
      email({ headers: { "list-unsubscribe": "<mailto:x@y.com>", "list-id": "acme" } })
    );

    // Assert
    expect(promptOf(fetchMock.mock.calls[0])).toContain("list-unsubscribe, list-id");
    expect(result).toMatchObject({ decision: "store", category: "Interview" });
  });

  test("throws instead of skipping when every model is unreachable", async () => {
    // Arrange: the failure mode that matters most. Reading an outage as "not job
    // related" banks the message in ignored_messages and it is never seen again.
    fetchMock.mockResolvedValue(new Response("boom", { status: 429, headers: { "retry-after": "0" } }));

    // Act
    const error = await classifyEmail(email()).catch((err) => err);

    // Assert
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect((error as LlmUnavailableError).isThrottled).toBe(true);
  });

  test("throws rather than guessing when the model answers with unparseable prose", async () => {
    // Arrange
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ model: PRIMARY_MODEL.id, choices: [{ message: { content: "I think it's an interview?" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    // Act
    const error = await classifyEmail(email()).catch((err) => err);

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("could not parse verdict");
  });

  test("reports which model answered, so a misclassification is diagnosable later", async () => {
    // Arrange
    fetchMock.mockResolvedValueOnce(answer({ isJob: true, category: "Offer", evidence: "pleased to offer you" }));

    // Act
    const result = await classifyEmail(email());

    // Assert
    expect(result).toEqual({
      decision: "store",
      category: "Offer",
      evidence: "pleased to offer you",
      model: PRIMARY_MODEL.id,
      usedFallback: false,
    });
  });
});
