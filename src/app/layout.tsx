import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Tracker",
  description: "Gmail-sorted job application pipeline with Telegram reminders",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning here specifically because a browser extension
    // (something injecting "data-tsenta-overlay-*" attributes) rewrites the <html>
    // tag before React hydrates. That's an extension in the browser, not a bug in
    // this app — this only silences the mismatch warning for this one tag, it
    // doesn't hide real hydration errors elsewhere in the tree.
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
