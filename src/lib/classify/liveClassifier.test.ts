import { describe, expect, test } from "vitest";
import { classifyEmail, type ClassifiableEmail } from "./index";

// Real calls to real models. Skipped unless RUN_LIVE_LLM=1, so an ordinary
// `npm test` stays free, offline and deterministic:
//
//   RUN_LIVE_LLM=1 npx vitest run src/lib/classify/liveClassifier.test.ts
//
// vitest does not read .env, so the key has to reach the process another way:
//
//   node --env-file=.env node_modules/vitest/vitest.mjs run src/lib/classify/liveClassifier.test.ts
//   (with RUN_LIVE_LLM=1 set: `$env:RUN_LIVE_LLM="1"` in PowerShell, `export RUN_LIVE_LLM=1` in bash)
//
// Every other test in this repo stubs fetch and therefore only proves the plumbing.
// This file is the only thing that proves the PROMPT works, which is where all three
// of the reported misclassifications actually lived. Roughly $0.0015 a full run.
//
// Fixtures are written from the failures that prompted the rewrite, not invented:
// promotional mail landing in pipeline categories, and assessments hidden inside
// emails whose subject line says "thank you for your application".

const LIVE = process.env.RUN_LIVE_LLM === "1";
const email = (overrides: Partial<ClassifiableEmail>): ClassifiableEmail => ({
  subject: "",
  from: "",
  to: "elon@example.com",
  cc: "",
  body: "",
  snippet: "",
  headers: {},
  ...overrides,
});

describe.skipIf(!LIVE)("classifyEmail against live models", () => {
  test("the buried assessment: subject says Applied, body says Assessment", async () => {
    // Arrange: complaint #2, verbatim in shape. Subject-only classification filed
    // this as Applied and the deadline was lost.
    const input = email({
      subject: "Thank you for applying to Micron Technology",
      from: "Micron Careers <no-reply@micron.com>",
      body: [
        "Dear Harsh,",
        "",
        "Thank you for your interest in Micron Technology. We have received your application for the AI Engineer position and our team is reviewing it.",
        "",
        "As part of our process, please complete the online technical assessment linked below within 5 days. Candidates who do not complete it by 12 September will not move forward.",
        "",
        "Start assessment: https://app.hackerrank.com/tests/abc123",
        "",
        "Best regards,",
        "Micron Talent Acquisition",
      ].join("\n"),
    });

    // Act
    const result = await classifyEmail(input);

    // Assert
    expect(result).toMatchObject({ decision: "store", category: "Assessment" });
  });

  test("a plain acknowledgement with no hidden action is still Applied", async () => {
    // Arrange: the control for the test above. Reading every acknowledgement as an
    // Assessment would be the opposite failure, and just as wrong.
    const result = await classifyEmail(
      email({
        subject: "We received your application",
        from: "Stripe Careers <careers@stripe.com>",
        body: "Thanks for applying to Stripe. Our recruiting team will review your application and be in touch if there is a match. You can check your status any time in the candidate portal.",
      })
    );

    // Assert
    expect(result).toMatchObject({ decision: "store", category: "Applied" });
  });

  // The first reclassify run over the real inbox dropped six genuine application
  // confirmations because they were relayed by LinkedIn, Indeed and Ashby rather than
  // sent by the employer. Over-rejecting is the more dangerous direction of the same
  // mistake promotional mail causes, so each of these is pinned from a real message.
  describe("application confirmations relayed by a platform", () => {
    test("LinkedIn 'your application was sent' is Applied, not a platform notification", async () => {
      const result = await classifyEmail(
        email({
          subject: "Harsh Rakesh, your application was sent to eBusiness Solutions, Inc.",
          from: "LinkedIn <jobs-noreply@linkedin.com>",
          body: "Your application was sent to eBusiness Solutions, Inc. Artificial Intelligence Engineer, eBusiness Solutions, Inc., Dallas, TX. View job: https://www.linkedin.com/jobs/view/123",
        })
      );

      expect(result).toMatchObject({ decision: "store", category: "Applied" });
    });

    test("an Ashby-relayed acknowledgement is Applied", async () => {
      const result = await classifyEmail(
        email({
          subject: "Thank you for applying to Juniper Square",
          from: "Juniper Square Talent Team <no-reply@ashbyhq.com>",
          body: "Hi Harsh, Thank you for submitting your application to the Forward Deployed Engineer, Applied AI position at Juniper Square! We've received your application and our team will review it shortly.",
        })
      );

      expect(result).toMatchObject({ decision: "store", category: "Applied" });
    });

    test("Indeed's 'your application has been submitted' is Applied", async () => {
      const result = await classifyEmail(
        email({
          subject: "Indeed Application: AI/ML Software Test Engineer (GenAI & Chatbot Solutions)",
          from: "Indeed Apply <indeedapply@indeed.com>",
          body: "Your application has been submitted. Good luck! If you notice an error in your application, please contact Indeed.",
        })
      );

      expect(result).toMatchObject({ decision: "store", category: "Applied" });
    });

    test("a LinkedIn status update whose body is all chrome is still Applied", async () => {
      // Arrange: verbatim from a real row. The subject carries the entire message and
      // the body is a logo, a "Your update from" line and a footer. Dropped on the
      // first corrected run because the body looked like a platform notification.
      const result = await classifyEmail(
        email({
          subject: "Your application to AI Engineer, Software at Future Secure AI",
          from: "LinkedIn <jobs-noreply@linkedin.com>",
          body: "Your update from Future Secure AI\n----------------------------------------\nThis email was intended for Harsh Rakesh Chauhan (Founding AI Engineer). Learn why we included this. https://www.linkedin.com/help\n\nYou are receiving LinkedIn notification emails.\nUnsubscribe · Help",
          headers: { "list-unsubscribe": "<mailto:unsubscribe@linkedin.com>" },
        })
      );

      expect(result).toMatchObject({ decision: "store", category: "Applied" });
    });

    test("but Indeed's 'could be a match, submit an application' is still not job mail", async () => {
      // Arrange: the control. Same sender domain, opposite direction of action.
      const result = await classifyEmail(
        email({
          subject: "Associate Concept Artist - Merch @ Catface",
          from: "Indeed <donotreply@indeed.com>",
          body: "Hi Harsh Rakesh, It looks like your background could be a match for this Associate Concept Artist - Merch role. Please submit a quick application if you are interested.",
        })
      );

      expect(result.decision).toBe("skip");
    });

    test("and ZipRecruiter's 'may want to hire you' is still not job mail", async () => {
      const result = await classifyEmail(
        email({
          subject: "Macmillan Learning may want to hire you",
          from: "ZipRecruiter <alerts@ziprecruiter.com>",
          body: "Macmillan Learning is hiring and your profile looks like a fit. Apply now to get in front of the hiring team.",
        })
      );

      expect(result.decision).toBe("skip");
    });
  });

  test("promotional 'this role matches your profile' is not a pipeline category", async () => {
    // Arrange: complaint #1. This survives the free prefilter (no alert sender, no
    // digest subject) and used to land in Interview or Assessment.
    const result = await classifyEmail(
      email({
        subject: "Senior AI Engineer at Rippling — a strong match for you",
        from: "Wellfound <team@wellfound.com>",
        headers: { "list-unsubscribe": "<mailto:unsub@wellfound.com>" },
        body: "Based on your profile we think you would be a great fit for this role. Apply now and get an interview faster. Companies like Rippling are actively hiring AI engineers this week.",
      })
    );

    // Assert
    expect(result.decision).toBe("skip");
  });

  test("a recruiter blast to many people is not job mail", async () => {
    // Arrange: the case that must stay a skip. Same sender type as the staffing cases
    // below, but sent to a list: no name, no single role, an unsubscribe footer.
    const result = await classifyEmail(
      email({
        subject: "Hot AI and data jobs this week from our recruiters",
        from: "TalentBridge Jobs <jobs@talentbridge.io>",
        headers: { "list-unsubscribe": "<mailto:unsub@talentbridge.io>" },
        body: "Hi there, here are 12 open roles our recruiters are filling right now: AI Engineer, Data Engineer, BI Developer and more. Reply to any recruiter on the list to learn more, or forward this to a friend. Unsubscribe at any time.",
      })
    );

    // Assert
    expect(result.decision).toBe("skip");
  });

  // Staffing/recruiter and Screening (issues #13, #14). These were written from the rules
  // in the prompt, not from real mail, and have not been run against a model by the
  // author: a failure here is a finding about the prompt to read, not automatically a bug.
  describe("recruiters", () => {
    test("an agency recruiter writing personally about a role, offering the job description, is Staffing/recruiter", async () => {
      // Arrange: this used to be a skip. The owner decided agency recruiter mail is kept.
      const result = await classifyEmail(
        email({
          subject: "AI Engineer opportunity - open to a chat?",
          from: "Dana Whitfield <dana@talentbridge.io>",
          body: "Hi Harsh, I came across your profile and I am recruiting for an AI Engineer role at a Series B startup. If you are interested I can set up an interview with the hiring manager this week. Let me know and I will send over the job description.",
        })
      );

      // Assert
      expect(result).toMatchObject({ decision: "store", category: "Staffing/recruiter" });
    });

    test("an agency job description is Staffing/recruiter, the agency is the employer, the client is in the evidence", async () => {
      const result = await classifyEmail(
        email({
          subject: "Data Engineer (hybrid, 12 months) - job description",
          from: "Dana Lee <dana@apexsystems.com>",
          body: [
            "Hi Harsh,",
            "",
            "I am a recruiter with Apex Systems. My client, Northwind Logistics, is hiring a Data Engineer for a 12 month hybrid contract.",
            "",
            "Requirements: 3+ years of Python and SQL, Airflow, a cloud warehouse. Pay: $60-70/hr.",
            "",
            "If this fits, please apply at https://apexsystems.example/jobs/8841 and send me your updated resume.",
            "",
            "Dana Lee | Apex Systems",
          ].join("\n"),
        })
      );

      // Assert
      expect(result).toMatchObject({ decision: "store", category: "Staffing/recruiter", employer: "Apex Systems" });
      if (result.decision === "store") expect(result.evidence).toMatch(/Northwind/i);
    });

    test("a recruiter's phone screen after he applied is Screening, not Interview", async () => {
      const result = await classifyEmail(
        email({
          subject: "Intro call about your Data Analyst application",
          from: "Priya Nair <recruiting@brightpath.com>",
          body: "Hi Harsh, thanks for applying to the Data Analyst role at BrightPath Health. I would like to set up a 20 minute intro call to learn about your background. What does your availability look like on Thursday or Friday?",
        })
      );

      // Assert
      expect(result).toMatchObject({ decision: "store", category: "Screening", employer: "BrightPath Health" });
    });

    test("an in-house recruiter writing to him personally, before he applied, is Screening", async () => {
      const result = await classifyEmail(
        email({
          subject: "Data Analyst role at Magpie Health",
          from: "Sam Ortiz <sam@magpiehealth.com>",
          body: "Hi Harsh, I am a recruiter here at Magpie Health. Your background looks like a strong fit for our Data Analyst opening. Do you have 15 minutes this week for a quick call?",
        })
      );

      // Assert
      expect(result).toMatchObject({ decision: "store", category: "Screening", employer: "Magpie Health" });
    });
  });

  test("a real interview invitation is Interview", async () => {
    const result = await classifyEmail(
      email({
        subject: "Next steps for your application",
        from: "Acme Recruiting <recruiting@acme.com>",
        body: "Hi Harsh, we enjoyed reviewing your application for the AI Engineer role and would like to move forward. Please pick a 45 minute slot with our hiring manager using the link below. Book here: https://calendly.com/acme/interview",
      })
    );

    expect(result).toMatchObject({ decision: "store", category: "Interview" });
  });

  test("an OTP from a careers portal is Verification, not Applied", async () => {
    // Arrange: the body says "application" twice. Category is decided by the payload.
    const result = await classifyEmail(
      email({
        subject: "Security code for your application to Modus Create",
        from: "Greenhouse <no-reply@greenhouse.io>",
        body: "Your security code is 483920. Enter it to finish signing in to your application portal. It expires in 10 minutes. If you did not request this, ignore this email.",
      })
    );

    expect(result).toMatchObject({ decision: "store", category: "Verification" });
  });

  test("a rejection behind a neutral subject is Rejection", async () => {
    const result = await classifyEmail(
      email({
        subject: "Update on your candidacy at Datadog",
        from: "Datadog Talent <talent@datadoghq.com>",
        body: "Hi Harsh, thank you for taking the time to interview with us. After careful consideration we have decided to move forward with other candidates whose experience more closely matches the role. We wish you the best in your search.",
      })
    );

    expect(result).toMatchObject({ decision: "store", category: "Rejection" });
  });

  test("an unrelated newsletter is not job mail at all", async () => {
    const result = await classifyEmail(
      email({
        subject: "Your weekly AI digest: 7 papers worth reading",
        from: "The Batch <newsletter@deeplearning.ai>",
        headers: { "list-unsubscribe": "<mailto:unsub@deeplearning.ai>" },
        body: "This week in AI: a new open weights model, three papers on retrieval, and a look at hiring trends across the industry. Read the full issue online.",
      })
    );

    expect(result.decision).toBe("skip");
  });
});
