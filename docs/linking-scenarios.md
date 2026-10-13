# Linking scenarios

Every scenario below becomes a test against the Linker (and Stage rules) before the code is written. Format: situation → expected result. "Ask" = Review item, nothing is auto-attached or auto-closed.

## Identity and grouping
1. Reply arrives in a known Thread → attach, 1.00, silent.
2. Same Employer, two different Roles applied the same day → two Applications.
3. New Thread, Employer + exact Role match, one open → attach, 0.90+.
4. New Thread, Employer + Role match but two open Applications with near-equal Role → ask.
5. Role in body but not subject ("your Data Scientist application") → use body Role.
6. No Role anywhere, one open Application at Employer → attach, flagged (0.70–0.89).
7. No Role anywhere, several open Applications at Employer → ask.
8. Role absent but an earlier Email in the same Thread named it → thread wins.
9. Same Role title, different term (Spring 2027 vs Summer 2026 intern) → different Applications.
10. Same title, different team/location ("SWE Intern — Security" vs "SWE Intern — Core Eng") → different Applications.
11. Role renamed between Applied and later email ("Software Engineer I" vs "SWE 1") → normalise; below threshold ask.
12. Requisition ID present → use as a bonus signal only (present in ~1% of bodies).

## Employer resolution
13. Mail from icims/greenhouse/lever/workday/ashby/smartrecruiters → Employer from display name, subject or body; Via = ATS.
14. Mail from a recruiter's personal Gmail/Outlook → Employer from signature/body; unresolvable → ask.
15. Staffing agency pitching a client → Employer = the client when named, else ask; agency is Via.
16. Alias/rename: "HPE", "Hewlett Packard Enterprise", "HP Enterprise" → one Employer.
17. Parent vs subsidiary (Amazon / AWS) → treat as the Employer the Email names; alias list decides merges.
18. Two Employers share a name stem ("Alpha FMC" vs "Alpha Systems") → no stem matching.
19. Employer name appears only inside a forwarded block → ignore forwarded text.

## Stage rules
20. Out-of-order arrival (Interview email lands before Applied email) → create Application from the earliest evidence; Applied date unknown (`?`).
21. Applied email never arrived, Interview email arrives → create Application at Interview stage.
22. Stage never moves backwards (Assessment after Interview does not demote).
23. Multiple rounds (R1, R2, Final) → Interview with round counter.
24. Assessment reminder / "are you still interested" → attach to Application if resolvable, else ask; never changes Stage.
25. Offer then rejection (rescinded) → Rejected, flagged.
26. Rejection with a named Role → close only that Application.
27. Rejection with no Role, one open Application → close it.
28. Rejection with no Role, several open Applications → ask, never auto-close.
29. Generic "decided to move forward with other candidates" from a no-reply ATS → same rules as 26–28.
30. Email after a Rejection in the same Thread (reopened) → reopen, flagged.

## Re-application and duplicates
31. Second Applied email, same Employer + Role, inside 90 days → attach, no new card (duplicate confirmation).
32. Same, after 90 days → new Application.
33. Applied confirmation resent/duplicated with identical subject → attaches to the same Application inside the 90-day window (no second Application). Each resent message is its own Email event, because Gmail gives it a new message id.
34. Applied after a Rejection of the same Role within 90 days → new Application (explicit retry), flagged.

## Non-application mail
35. OTP / verify-your-email → never creates or moves an Application.
36. Newsletter / "jobs you may like" from an Employer you applied to → ignored.
37. Recruiter cold outreach, no prior application: an in-house recruiter writing to you personally is Screening (creates a flagged Application and sends the Telegram ping); a staffing agency's job description is Staffing/recruiter (scenarios 45–49). Mass outreach sent to many people is still skipped.
38. Your own reply (is_from_me) → attach as event, never create an Application.
39. Calendar invites (Calendly, Zoom, Google Calendar) → attach by Thread, else by Employer + Role in body, else ask.
40. Email addressed to a different candidate or forwarded by you to someone → ignore.

## Volume
41. 30 Applied emails in one sync run, all new → 30 Applications, zero questions.
42. Re-running sync on the same window → no duplicate Emails, Applications or Review items.
43. Sync interrupted mid-run → resumable; partially linked state is never visible as a wrong merge.
44. Override (split/merge/detach) → later Emails in that Thread follow the corrected Application; the override is stored as a labelled example.

## Screening and Staffing/recruiter
45. A recruiter's intro, phone-screen invite or request for your availability → Screening: the Application moves to the Screening stage (or is created there, flagged, if no Applied email came first) and you get the Telegram ping, repeat reminders and due-date extraction.
46. A staffing agency recruiter sends position details or a job description and asks you to apply → Staffing/recruiter: stored and shown in the Inbox, with the agency as the Employer. No Application, no Review item, no Telegram. The client it names stays in the evidence text.
47. The same Gmail thread later becomes a Screening, Assessment, Interview or Offer email → the Application is created with the agency as Employer, and the earlier job descriptions in that thread join its timeline. Stage and last-activity date are set by the real email, not by the job description.
48. Another job description arrives in a thread that already belongs to an Application → it joins that Application's timeline and changes nothing else (it does not reopen a rejection).
49. The client later writes from its own name or domain → a different Employer, so a separate Application. Use Merge on the Application page if they are the same job. There is no agency-to-client matching.

## Where each scenario is tested
- Linker (`src/lib/link/decideLink.test.ts`): 1-11, 13-18, 20-21, 24, 26-29, 31-34, 39, 48. Scenario 12 (req ids) is exercised through role matching.
- Screening and Staffing/recruiter: 45 in `store.test.ts`, `actions.test.ts` and `prompt.test.ts`; 46-49 in `decideLink.test.ts`, `planLinks.test.ts` (adoption) and `store.test.ts` (real SQL). What the model actually answers for 45–46 is only measured by `npm run eval:extraction`.
- Stage rules (`src/lib/link/nextState.test.ts`): 22-25, 30.
- Own replies and ignored mail (`decideLink.test.ts`): 35, 36, 38.
- Classifier extraction (T4): 19 (forwarded blocks), 40 (mail not addressed to the owner), and employer extraction for 13-15.
- Sync integration (T5): 41-43. Overrides (T7): 44.
