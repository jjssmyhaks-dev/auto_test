/**
 * Minimal 5-field cron parser (minute hour day-of-month month day-of-week)
 * with next-occurrence calculation. Supports star, star-slash-step, ranges,
 * lists, and plain values. Day-of-week: 0-7 (0 and 7 = Sunday). No timezone
 * support — schedules run in the server's local time.
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when day-of-month was `*` (all days). */
  domUnrestricted: boolean;
  /** True when day-of-week was `*` (all days). */
  dowUnrestricted: boolean;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(field: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`invalid cron field: "${part}"`);
    const [, base, stepRaw] = m;
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: "${part}"`);
    let lo: number, hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (base.includes("-")) {
      const [a, b] = base.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = hi = Number(base);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron field out of range: "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression must have 5 fields: "${expr}"`);
  const fields = parts.map((p, i) => parseField(p, RANGES[i]));
  const [minutes, hours, daysOfMonth, months, daysOfWeekRaw] = fields;
  // 7 also means Sunday.
  const daysOfWeek = new Set(daysOfWeekRaw);
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  // Track "restricted" explicitly: `*` over [0,7] yields 8 values, and a
  // plain size check would misread it as a restricted day list.
  const dowUnrestricted = /(^|[,\s])\*(\/|$|,)/.test(parts[4]) || daysOfWeek.size === 8;
  return { minutes, hours, daysOfMonth, months, daysOfWeek, dowUnrestricted, domUnrestricted: daysOfMonth.size === 31 };
}

/** Does `date` match the (already parsed) expression? Second-granularity ignored. */
export function cronMatches(c: CronFields, date: Date): boolean {
  if (!c.minutes.has(date.getMinutes())) return false;
  if (!c.hours.has(date.getHours())) return false;
  if (!c.months.has(date.getMonth() + 1)) return false;
  const domOk = c.daysOfMonth.has(date.getDate());
  const dowOk = c.daysOfWeek.has(date.getDay());
  // Standard cron semantics: if both DOM and DOW are restricted, either may match.
  if (!c.domUnrestricted && !c.dowUnrestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** Next occurrence at or after `from` (exclusive of `from`'s seconds), scanning minute-by-minute. */
export function nextCronOccurrence(expr: string, from = new Date()): Date | undefined {
  const c = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // Bounded scan: at most ~3 years of minutes before we declare it unsatisfiable.
  const limit = 3 * 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(c, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return undefined;
}
