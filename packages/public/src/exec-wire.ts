import { z } from 'zod';

/** The synchronous public command shape shared with the regional execution entry. */
export const SyncExecInput = z
  .object({
    cmd: z.array(z.string().max(65_536)).min(1).max(256),
    // Accept the same timeout range as the command API; synchronous execution caps it.
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60_000)
      .optional(),
    stdin: z.string().max(1_000_000).optional(),
    env: z.record(z.string(), z.string()).optional(),
    clearEnv: z.boolean().optional(),
  })
  .strict();

export const SyncExecOutput = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int(),
    timedOut: z.boolean(),
    truncated: z.boolean(),
    costLine: z.string(),
    warning: z.string().optional(),
  })
  .strict();

export type SyncExecInput = z.infer<typeof SyncExecInput>;
export type SyncExecOutput = z.infer<typeof SyncExecOutput>;
