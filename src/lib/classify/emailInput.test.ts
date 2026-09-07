import { describe, expect, test } from "vitest";
import { buildClassifierInput, isDirectRecipient, type EmailForClassification } from "./emailInput";

const email = (overrides: Partial<EmailForClassification> = {}): EmailForClassification => ({
  subject: "Thank you for your application",
  from: "Acme Careers <careers@acme.com>",
  to: "elon@example.com",
  cc: "",
  body: "Thanks for applying.",
  snippet: "Thanks for applying.",
  bulkSignals: [],
  directRecipient: true,
  ...overrides,
});

describe("buildClassifierInput", () => {
  test("includes the body, because the subject is what used to mislead the classifier", () => {
    // Arrange: the exact shape that was being filed as Applied — a bland subject with
    // the assessment and its deadline buried below the fold.
    const input = buildClassifierInput(
      email({
        subject: "Thank you for your application",
        body: "We received it.\n\nNext step: complete the online assessment by Friday 5pm.",
      })
    );

    // Assert
    expect(input).toContain("complete the online assessment by Friday 5pm");
  });

  test("falls back to the snippet when the message had no text part", () => {
    const input = buildClassifierInput(email({ body: "", snippet: "only a snippet survived" }));
    expect(input).toContain("only a snippet survived");
  });

  test("keeps the tail of a long body, where deadlines and sign-offs live", () => {
    // Arrange: a head-only truncation throws away exactly the part that carries the
    // due date, which is the thing the reminder pass depends on.
    const body = `${"filler sentence. ".repeat(1_000)}\nDeadline: 12 September, 5pm.`;

    // Act
    const input = buildClassifierInput(email({ body }));

    // Assert
    expect(input).toContain("Deadline: 12 September, 5pm.");
    expect(input).toContain("[...trimmed...]");
  });

  test("bounds the total size so one marketing footer cannot blow up the bill", () => {
    const input = buildClassifierInput(email({ body: "x".repeat(500_000) }));
    expect(input.length).toBeLessThan(6_000);
  });

  test("truncates tracking URLs but keeps the host and path, which carry the signal", () => {
    // Arrange
    const body = `Start here: https://app.hackerrank.com/tests/abc123?${"t=1&".repeat(300)}`;

    // Act
    const input = buildClassifierInput(email({ body }));

    // Assert
    expect(input).toContain("https://app.hackerrank.com/tests/abc123");
    expect(input).toContain("…");
    expect(input.length).toBeLessThan(1_000);
  });

  test("passes bulk-mail headers as a hint, explicitly not as a verdict", () => {
    // Arrange: recruiters replying inside a live thread do send through platforms
    // that set List-Unsubscribe. Stating this as proof would drop real invites.
    const input = buildClassifierInput(email({ bulkSignals: ["list-unsubscribe", "list-id"] }));

    // Assert
    expect(input).toContain("list-unsubscribe, list-id");
    expect(input).toContain("not proof");
  });

  test("says nothing about recipients when OWNER_EMAIL is unknown", () => {
    // Arrange: null must not be reported as "no", which would be an invented signal.
    const input = buildClassifierInput(email({ directRecipient: null }));

    // Assert
    expect(input).not.toContain("not an explicit To/Cc recipient");
  });

  test("flags a blast that does not name the owner in To or Cc", () => {
    const input = buildClassifierInput(email({ directRecipient: false }));
    expect(input).toContain("not an explicit To/Cc recipient");
  });
});

describe("isDirectRecipient", () => {
  test("matches the owner in To regardless of display name or case", () => {
    expect(isDirectRecipient(email({ to: '"Elon" <ELON@example.com>' }), "elon@example.com")).toBe(true);
  });

  test("matches the owner in Cc", () => {
    expect(isDirectRecipient(email({ to: "someone@else.com", cc: "elon@example.com" }), "elon@example.com")).toBe(true);
  });

  test("is false for a blast addressed to an undisclosed list", () => {
    expect(isDirectRecipient(email({ to: "undisclosed-recipients:;", cc: "" }), "elon@example.com")).toBe(false);
  });

  test("is false rather than throwing when OWNER_EMAIL is empty", () => {
    expect(isDirectRecipient(email(), "")).toBe(false);
  });
});
