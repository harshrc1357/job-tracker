import { describe, expect, test } from "vitest";
import { keywordClassify } from "./classify";

// The keyword pass is now load-bearing for cost, not just speed: anything it catches
// costs zero LLM calls, and the free tier is 250 calls a DAY. A rule that stops
// matching quietly turns into quota exhaustion.
describe("keywordClassify", () => {
  test("files a Greenhouse security code as Verification, not Applied", () => {
    // Arrange: this exact email shape was sitting in the Reminder category and
    // generating nudges. It contains "application", which Applied also matches, so
    // rule order is what decides it.
    const subject = "Security code for your application to Modus Create";
    const snippet = "Your security code is 123456. It expires in 10 minutes.";

    // Act
    const category = keywordClassify(subject, snippet);

    // Assert
    expect(category).toBe("Verification");
  });

  test("catches one-time passwords and OTP phrasing", () => {
    expect(keywordClassify("Your one-time passcode", "")).toBe("Verification");
    expect(keywordClassify("OTP for login", "")).toBe("Verification");
    expect(keywordClassify("Please verify your email address", "")).toBe("Verification");
    expect(keywordClassify("Reset your password", "")).toBe("Verification");
  });

  test("still recognises the ordinary pipeline categories", () => {
    expect(keywordClassify("Thank you for applying to Micron", "")).toBe("Applied");
    expect(keywordClassify("Interview confirmation", "")).toBe("Interview");
    expect(keywordClassify("Your online assessment", "")).toBe("Assessment");
    expect(keywordClassify("We are pleased to offer you", "")).toBe("Offer");
    expect(keywordClassify("Unfortunately we will not be moving forward", "")).toBe("Rejection");
  });

  test("returns null when nothing matches, so the caller can decide to spend a call", () => {
    // Arrange
    const subject = "Lunch tomorrow?";

    // Act
    const category = keywordClassify(subject, "are you free at noon");

    // Assert
    expect(category).toBeNull();
  });

  test("matches against the snippet as well as the subject", () => {
    // Arrange: plenty of ATS mail has a generic subject and the real signal in the body.
    const subject = "Update on your candidacy";
    const snippet = "We regret to inform you that we are pursuing other candidates.";

    // Act
    const category = keywordClassify(subject, snippet);

    // Assert
    expect(category).toBe("Rejection");
  });
});
