import { z } from 'zod';
import { DEFAULT_PLAN, PLAN_LIMITS, type Plan } from './plans.js';
import { Size } from './sizes.js';
import { Sleep } from './sleep.js';

/** What a credential (an API key, a signed-in agent) may spend and run: its budget. */
export const KeyPolicy = z.object({
  /** `null`: not set, so the team's plan decides (`PLAN_LIMITS[plan].defaultKeyConcurrentBriqs`). */
  maxConcurrentBriqs: z.number().int().min(0).nullable().default(null),
  dailySpendCapCents: z.number().int().min(0).default(1000),
  /** By default, the starting plan's own sizes; the team's plan still decides at create time. */
  allowedSizes: z.array(Size).default(() => [...PLAN_LIMITS[DEFAULT_PLAN].sizes]),
  /** Registries a key may pull images from. */
  allowedRegistries: z.array(z.string()).default(['docker.io', 'ghcr.io', 'quay.io']),
  /**
   * The longest `sleep` this credential may give a briq, `"never"` included. By default no bound
   * of its own: the environment's maximum and the plan (always on is Pro and above) still apply.
   */
  maxSleep: Sleep.default('never').describe(
    'The longest sleep this credential may give a briq, "never" included ("never": no bound of its own; the environment and the plan still apply)',
  ),
  expiresAt: z.string().datetime().nullable().default(null),
});
export type KeyPolicy = z.infer<typeof KeyPolicy>;
/** A policy with the plan's default filled in: what a request is checked against. */
export type ResolvedKeyPolicy = KeyPolicy & { maxConcurrentBriqs: number };
/** Fill in a limit nobody set from the team's current plan, so a key that kept the default follows a plan change. */
export function resolveKeyPolicy(policy: KeyPolicy, plan: Plan): ResolvedKeyPolicy {
  return {
    ...policy,
    maxConcurrentBriqs: policy.maxConcurrentBriqs ?? PLAN_LIMITS[plan].defaultKeyConcurrentBriqs,
  };
}
/** A partial policy where explicit `undefined` is allowed (what zod `.partial()` produces). */
export type PolicyPatch = { [K in keyof KeyPolicy]?: KeyPolicy[K] | undefined };
