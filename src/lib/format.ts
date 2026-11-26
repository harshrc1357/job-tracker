const SHORT = { month: "short", day: "2-digit" } as const;
export const shortDate = (d: Date | null | undefined): string => (d ? new Date(d).toLocaleDateString("en-US", SHORT) : "?");
export const fullDate = (d: Date): string =>
  new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
