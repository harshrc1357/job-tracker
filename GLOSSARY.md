# Glossary

**Email** — one Gmail message that survived the prefilter and classifier. Stored as a row in the table named `applications` (a legacy misnomer; renaming it is a wide refactor left for later). Each Email points at its Application through `job_application_id`.

**Application** — stored in `job_applications`. One attempt to get one **Role** at one **Employer**, from the Applied email onward. The unit shown on Pipeline, Applications and Detail. An Application owns many Emails. _Avoid:_ "job", "card" (a card is only how Pipeline draws an Application).

**Employer** — the real company hiring (Cotiviti), never the ATS or the sender. Identified by a canonical name plus an alias list (HPE = Hewlett Packard Enterprise). _Avoid:_ "company" when the sender could be meant.

**Via** — the ATS or agency an Email travelled through (icims, greenhouse, a staffing firm). Metadata only; never decides the Employer.

**Role** — the job title plus any term/cohort that distinguishes openings (Spring 2027 vs Summer 2026). Normalised for comparison.

**Thread** — a Gmail threadId. ATS replies stay in-thread, so a known Thread is the strongest link.

**Stage** — Applied → Screening / Assessment → Interview (rounds) → Offer; Rejected is terminal.

**Link** — the decision that attaches an Email to an Application, with a **Confidence** 0–1 and the evidence used.

**Linker** — the module that produces a Link. Ladder: Thread → Employer + Role → Employer only (one open Application) → ask.

**Review item** — an Email the Linker would not decide (confidence < 0.70). Resolved by one tap.

**Split / Merge / Detach** — user overrides on an Application. Every override is stored as a labelled example.

**Split bias** — when unsure the Linker creates/keeps separate Applications rather than merging. A wrong merge hides a live interview; a wrong split is two Applications.

**Progressed** — an Application with any Email past Applied. Only Progressed Applications appear on Pipeline.

**Ghosted** — Applied-only with no reply for 30+ days. Never deleted.

**Re-application window** — 90 days. A new Applied email for the same Employer + Role inside it attaches to the existing Application; after it, it starts a new one.
