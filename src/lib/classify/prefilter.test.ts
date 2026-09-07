import { describe, expect, test } from "vitest";
import { prefilter } from "./prefilter";

const email = (over: Partial<Parameters<typeof prefilter>[0]> = {}) => ({
  subject: "",
  from: "",
  body: "",
  headers: {},
  ...over,
});

// The prefilter exists to save money, not to make judgement calls. Its whole design
// rule is asymmetric: wrongly passing a promo email to the LLM costs about $0.0001,
// wrongly rejecting a real one loses an interview. So it only fires on things that
// cannot plausibly be a real reply about his own application.
describe("prefilter — rejects only unambiguous bulk job advertising", () => {
  test("rejects LinkedIn job alert blasts by sender", () => {
    // Arrange: the single biggest source of noise in the inbox.
    const input = email({
      from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>",
      subject: "Software Engineer: Acme Corp and 9 more jobs for you",
    });

    // Act
    const verdict = prefilter(input);

    // Assert. Narrowed rather than asserted-then-indexed, so the reason is only read
    // on the branch that actually carries one.
    if (verdict.decision !== "reject") throw new Error("expected a reject verdict");
    expect(verdict.reason).toContain("sender");
  });

  test("rejects Indeed and Glassdoor alert senders too", () => {
    expect(prefilter(email({ from: "alert@indeed.com" })).decision).toBe("reject");
    expect(prefilter(email({ from: "donotreply@match.indeed.com" })).decision).toBe("reject");
    expect(prefilter(email({ from: "noreply@glassdoor.com" })).decision).toBe("reject");
    expect(prefilter(email({ from: "jobs-listings@linkedin.com" })).decision).toBe("reject");
  });

  test("rejects digest subjects that can only be advertising", () => {
    expect(prefilter(email({ subject: "12 new jobs for you" })).decision).toBe("reject");
    expect(prefilter(email({ subject: "Your job alert for Data Engineer" })).decision).toBe("reject");
    expect(prefilter(email({ subject: "New jobs matching your search" })).decision).toBe("reject");
    expect(prefilter(email({ subject: "Recommended jobs for you this week" })).decision).toBe("reject");
  });

  test("does NOT reject a real reply that merely came from a job board domain", () => {
    // Arrange: LinkedIn also relays genuine recruiter InMail. The sender rules are
    // scoped to alert mailboxes precisely so this survives.
    const input = email({
      from: "LinkedIn <messages-noreply@linkedin.com>",
      subject: "Priya sent you a message about the Backend Engineer role",
    });

    // Act / Assert
    expect(prefilter(input).decision).toBe("pass");
  });

  test("does NOT reject on soft marketing wording a recruiter might also use", () => {
    // Arrange: "apply now" and "we're hiring" read like promo, but a recruiter
    // following up on a live conversation says both. The LLM decides these, not us.
    expect(prefilter(email({ subject: "Apply now to the role we discussed" })).decision).toBe("pass");
    expect(prefilter(email({ subject: "We're hiring - following up on your chat with Sam" })).decision).toBe("pass");
  });

  test("does NOT reject purely because the email carries List-Unsubscribe", () => {
    // Arrange: Greenhouse, Workday and Lever all set List-Unsubscribe on genuine
    // transactional pipeline mail. Rejecting on it would gut the whole tracker.
    const input = email({
      from: "Greenhouse <no-reply@greenhouse.io>",
      subject: "Your application to Modus Create",
      headers: { "list-unsubscribe": "<https://greenhouse.io/unsub>" },
    });

    // Act
    const verdict = prefilter(input);

    // Assert
    expect(verdict.decision).toBe("pass");
    expect(verdict.bulkSignals).toContain("list-unsubscribe");
  });

  test("passes bulk signals through so the LLM can weigh them", () => {
    // Arrange
    const input = email({
      subject: "Opportunities at Acme",
      headers: { precedence: "bulk", "list-unsubscribe": "<mailto:x@y.z>" },
    });

    // Act
    const verdict = prefilter(input);

    // Assert
    expect(verdict.decision).toBe("pass");
    expect(verdict.bulkSignals).toEqual(
      expect.arrayContaining(["list-unsubscribe", "precedence-bulk"])
    );
  });

  test("passes ordinary pipeline mail with no signals at all", () => {
    // Arrange
    const input = email({
      from: "Recruiting Team <hr@bjak.my>",
      subject: "Thank you for your application",
      body: "We have received your application for the AI Engineer position.",
    });

    // Act
    const verdict = prefilter(input);

    // Assert
    expect(verdict.decision).toBe("pass");
    expect(verdict.bulkSignals).toEqual([]);
  });

  test("is case and whitespace insensitive on the sender", () => {
    expect(prefilter(email({ from: "  <JobAlerts-NoReply@LinkedIn.COM>  " })).decision).toBe("reject");
  });
});
