"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Counts = { pipeline: number; applications: number; inbox: number; review: number } | null;

const TABS = [
  { href: "/", label: "Pipeline", key: "pipeline" },
  { href: "/applications", label: "Applications", key: "applications" },
  { href: "/inbox", label: "Inbox", key: "inbox" },
  { href: "/review", label: "Review", key: "review" },
] as const;

export function TabNav({ counts }: { counts: Counts }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  return (
    <nav className="nav-tabs" aria-label="Sections">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={`nav-tab ${isActive(t.href) ? "active" : ""}`}>
          {t.label}
          {counts && <span className={`nav-count ${t.key === "review" && counts.review > 0 ? "attn" : ""}`}>{counts[t.key]}</span>}
        </Link>
      ))}
    </nav>
  );
}
