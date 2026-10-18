import { z } from 'zod';

/**
 * When a briq goes to sleep: after this long without use, or never.
 *
 * A sleeping briq is stopped, keeps its disk and is not billed for compute; the next use wakes it
 * (an agent call, or a request to a URL of its stack). This is the one setting that decides when
 * a briq stops on its own. There is no deadline that stops a briq while it is in use: the spend
 * cap and the team's credits bound what a briq in use can cost.
 *
 * Written as a string, one number and one unit: `"30m"`, `"3h"`, `"7d"`, or `"never"` (always on,
 * on plans that allow it). A number is refused with the fix in the message, never read as minutes.
 */

/** Always on: the briq runs until something stops it. */
export const SLEEP_NEVER = 'never';
/** Shorter windows make a briq that cold-boots stop and start on every visit. */
export const MIN_SLEEP_MINUTES = 5;
/** The longest window anywhere: seven days. An environment may set a shorter one. */
export const MAX_SLEEP_MINUTES = 10_080;

const UNITS = { m: 1, h: 60, d: 1440 } as const;
/** A sleep value's shape: one number and one unit, or `never`. Bounds are checked apart. */
export const SLEEP_PATTERN = /^(?:never|[1-9][0-9]{0,4}[mhd])$/;
const PATTERN = SLEEP_PATTERN;

/** `"90m"` → 90, `"never"` → null. Undefined when `sleep` is not a sleep value at all. */
export function sleepMinutes(sleep: string): number | null | undefined {
  if (sleep === SLEEP_NEVER) return null;
  if (!PATTERN.test(sleep)) return undefined;
  return Number(sleep.slice(0, -1)) * UNITS[sleep.slice(-1) as keyof typeof UNITS];
}

/** 120 → `"2h"`, 90 → `"90m"`, null → `"never"`: the shortest exact form, as responses show it. */
export function formatSleep(minutes: number | null): string {
  if (minutes === null) return SLEEP_NEVER;
  if (minutes % UNITS.d === 0) return `${minutes / UNITS.d}d`;
  if (minutes % UNITS.h === 0) return `${minutes / UNITS.h}h`;
  return `${minutes}m`;
}

/** What a person reads: "30 minutes", "2 hours", "1 day", "never". */
export function describeSleep(sleep: string): string {
  const minutes = sleepMinutes(sleep);
  if (minutes === null) return 'never';
  if (minutes === undefined) return sleep;
  const short = formatSleep(minutes);
  const n = Number(short.slice(0, -1));
  const unit = { m: 'minute', h: 'hour', d: 'day' }[short.slice(-1) as 'm' | 'h' | 'd'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Whether window `a` is longer than window `b`, `"never"` being longer than any. */
export function sleepsLonger(a: string, b: string): boolean {
  const x = sleepMinutes(a) ?? Number.POSITIVE_INFINITY;
  const y = sleepMinutes(b) ?? Number.POSITIVE_INFINITY;
  return x > y;
}

const FORMAT = '"30m", "3h", "7d" or "never"';

/**
 * The message for a `sleep` that is not a string, with the string it most likely meant. Shared
 * with the MCP tools, whose own schema refuses a number before the API sees it.
 */
export function sleepTypeMessage(data: unknown): string {
  if (typeof data === 'number')
    return `sleep must be a string: ${FORMAT}. You sent ${data}, a number. For ${data} minutes, pass "${data}m"`;
  return `sleep must be a string: ${FORMAT}`;
}

/** The message for a string that is not a sleep value. */
export const SLEEP_SHAPE_MESSAGE = `sleep must be a number and a unit (m, h or d), or "never": ${FORMAT}`;

export const Sleep = z
  .string({
    errorMap: (issue, ctx) =>
      issue.code === 'invalid_type'
        ? { message: sleepTypeMessage(ctx.data) }
        : { message: ctx.defaultError },
  })
  .regex(PATTERN, SLEEP_SHAPE_MESSAGE)
  .superRefine((v, ctx) => {
    const minutes = sleepMinutes(v);
    if (minutes === null || minutes === undefined) return;
    if (minutes < MIN_SLEEP_MINUTES)
      ctx.addIssue({ code: 'custom', message: `sleep is at least "${MIN_SLEEP_MINUTES}m"` });
    if (minutes > MAX_SLEEP_MINUTES)
      ctx.addIssue({
        code: 'custom',
        message: `sleep is at most "${formatSleep(MAX_SLEEP_MINUTES)}", or "never"`,
      });
  })
  .describe(
    `When the briq goes to sleep: after this long without use (agent calls, visits to its stack's URLs). A string: ${FORMAT}, never a number. A sleeping briq keeps its disk, costs nothing for compute, and the next use wakes it. "never" keeps it always on (Pro plan and above)`,
  );
export type Sleep = z.infer<typeof Sleep>;
