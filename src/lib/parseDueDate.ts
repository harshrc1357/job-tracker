// Turns whatever the LLM replied with into a real instant.
//
// The bug this exists to kill: the model returns offset-less strings like
// "2026-09-10T14:00:00", and `new Date(that)` resolves it against the *server's*
// zone. Vercel runs in UTC, so 2pm Central was stored as 2pm UTC and every reminder
// fired five hours early. A bare datetime means "local time where the event is",
// which for a single-user tool means the owner's zone, so that is what we resolve
// against — explicitly, not by accident of where the function happens to run.

// Matches a trailing "Z" or "+05:30"/"-04:00" style offset. If the model gave us
// one, it already pinned the instant and we must not re-zone it.
const HAS_EXPLICIT_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BARE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

// How far the offset lookup is allowed to iterate. Two passes settles every real
// case including the ambiguous hour at a DST boundary.
const OFFSET_REFINEMENT_PASSES = 2;

// Milliseconds to add to a wall-clock reading in `timeZone` to get UTC.
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl can emit hour 24 for midnight in some locales/engines.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );

  return asIfUtc - instant.getTime();
}

// Interprets a wall-clock string as a time in `timeZone`. Starts by pretending the
// reading is UTC, then corrects by that moment's offset. Repeats once because the
// offset itself depends on the instant, which shifts around a DST changeover.
function fromZonedWallClock(wallClockIso: string, timeZone: string): Date | null {
  const naive = new Date(`${wallClockIso}Z`);
  if (Number.isNaN(naive.getTime())) return null;

  let instant = naive;
  for (let pass = 0; pass < OFFSET_REFINEMENT_PASSES; pass++) {
    instant = new Date(naive.getTime() - zoneOffsetMs(instant, timeZone));
  }
  return instant;
}

export function parseDueDate(raw: string, timeZone: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith("none")) return null;

  if (HAS_EXPLICIT_OFFSET.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // A bare date means midnight that day, in the owner's zone.
  if (BARE_DATE.test(trimmed)) return fromZonedWallClock(`${trimmed}T00:00:00`, timeZone);

  if (BARE_DATETIME.test(trimmed)) {
    const normalized = trimmed.replace(" ", "T");
    const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized;
    return fromZonedWallClock(withSeconds, timeZone);
  }

  // Anything else (prose, half a sentence, a model apology) is not a date. Refusing
  // to guess here is deliberate: a wrong due date sends four wrong reminders.
  return null;
}
