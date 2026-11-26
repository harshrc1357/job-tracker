import { describe, expect, test } from "vitest";
import { canPing, kindOf } from "./kindOf";

const row = (category: string, fromEmail: string, subject: string) => ({ category, fromEmail, subject });

// Real senders and subjects. A job board's alert lists openings; it says nothing about an
// application of the owner, so it must never create or join one.
describe("kindOf: job alerts and surveys are marketing, whatever the classifier said", () => {
  test.each([
    ["Applied", "alerts@ziprecruiter.com", "Glenmoor has a Senior Principal Low Observables Material Engineer opening now"],
    ["Applied", "alerts@ziprecruiter.com", "Alex, Kirkwood has an open position"],
    ["Screening", "alerts@ziprecruiter.com", "$145/hr Embedded Software Engineers job in Fairview, CO"],
    ["Reminder", "alerts@ziprecruiter.com", "Lakeside State University may want to hire you"],
    ["Applied", "alerts@ziprecruiter.com", "Lakeside State University is hiring now. August 11, 2026"],
    ["Staffing/recruiter", "phil@ziprecruiter.com", "ZipRecruiter's Sr Software Engineer opening for you!"],
    ["Reminder", "team@hi.wellfound.com", "New jobs: Senior Software Engineer at Larkin and 5 more jobs"],
    ["Reminder", "jobs-noreply@linkedin.com", "VLM is hiring for a Media role"],
    ["Reminder", "jobs-noreply@linkedin.com", "Valemont Global is hiring a Technical Implementation Analyst"],
    ["Reminder", "noreply_v-mobile@qemailserver.com", "We'd Love to Hear About Your Application Experience"],
    ["Rejection", "support@recruitingexperience.ashgrove.com", "How was your Ashgrove recruiting experience?"],
    // A survey names no sender rule: the subject alone says it asks for a rating.
    ["Rejection", "noreply@survey.example", "Rate your job application experience at Hawthorne"],
    // A survey can also ask in "Tell us about" words. The classifier called this real row Assessment.
    ["Assessment", "noreply@enterpriselistening.example", "Tell Us About Your Application Experience :WD00000001 - AI Platform Engineer"],
    // A job board mails from subdomains too.
    ["Screening", "alerts@em.ziprecruiter.com", "$145/hr Embedded Software Engineers job in Fairview, CO"],
    ["Applied", "team@em.ziprecruiter.com", "Glenmoor has an opening for you"],
  ])("%s mail from %s, %j", (category, fromEmail, subject) => {
    expect(kindOf(row(category, fromEmail, subject))).toBe("marketing");
  });
});

// The same senders also carry mail about a real application. These keep the kind of their category.
describe("kindOf: mail about a real application keeps the kind of its category", () => {
  test.each([
    ["Applied", "phil@ziprecruiter.com", 'Your "AI/ML Engineer" application is complete', "applied"],
    ["Reminder", "jobs-noreply@linkedin.com", "Your application to AI Engineer at The Westmere Group", "reminder"],
    ["Reminder", "jobs-noreply@linkedin.com", "Problem with your Forward Deployed AI Accelerator application", "reminder"],
    ["Reminder", "jobs-noreply@linkedin.com", "Alex Morgan, don’t forget to complete your application to Yewtree", "reminder"],
    ["Interview", "recruiting@alderwood.com", "Schedule your Alderwood interview", "interview"],
    // "is hiring" is only a job alert when a job board sends it.
    ["Staffing/recruiter", "sam@agency.example", "Acme is hiring a Data Scientist", "staffing"],
    // A look-alike domain is not the job board.
    ["Applied", "alerts@notziprecruiter.com", "Acme has an open position", "applied"],
    // "love to hear about your" is a survey only when it asks about the experience.
    ["Screening", "recruiter@acme.example", "We'd love to hear about your background", "screening"],
    // "Tell us about your" is a survey only when it asks about the hiring process.
    ["Screening", "recruiter@acme.example", "Tell us about your experience with Python", "screening"],
  ])("%s mail from %s, %j is %s", (category, fromEmail, subject, kind) => {
    expect(kindOf(row(category, fromEmail, subject))).toBe(kind);
  });

  test("a category the app does not know is marketing", () => {
    expect(kindOf(row("Nonsense", "a@b.example", "Hello"))).toBe("marketing");
  });

  test("a missing sender or subject does not break it", () => {
    expect(kindOf({ category: "Rejection", fromEmail: null, subject: null })).toBe("rejection");
  });
});

// Telegram and the "due soon" reminders are for mail about the owner's own applications. A job alert
// that the classifier filed as Screening (a real row) must not interrupt them.
describe("canPing: only real Screening, Interview, Assessment and Offer mail pings", () => {
  test.each([
    ["Screening", "recruiter@acme.example", "Intro call with Acme"],
    ["Interview", "recruiting@alderwood.com", "Schedule your Alderwood interview"],
    ["Assessment", "noreply@hackerrank.example", "Complete your assessment"],
    ["Offer", "hr@acme.example", "Your offer from Acme"],
    ["Screening", "recruiter@acme.example", "Tell us about your experience with Python"],
  ])("%s mail from %s, %j pings", (category, fromEmail, subject) => {
    expect(canPing(row(category, fromEmail, subject))).toBe(true);
  });

  test.each([
    ["Screening", "alerts@ziprecruiter.com", "$145/hr Embedded Software Engineers job in Fairview, CO"],
    ["Interview", "support@recruitingexperience.ashgrove.com", "How was your Ashgrove recruiting experience?"],
    ["Applied", "phil@ziprecruiter.com", 'Your "AI/ML Engineer" application is complete'],
    ["Rejection", "recruiting@alderwood.com", "Update on your application"],
    // A real row: a survey filed as Assessment got a due date and sent the final Telegram reminder.
    ["Assessment", "noreply@enterpriselistening.example", "Tell Us About Your Application Experience :WD00000001 - AI Platform Engineer"],
  ])("%s mail from %s, %j does not ping", (category, fromEmail, subject) => {
    expect(canPing(row(category, fromEmail, subject))).toBe(false);
  });
});
