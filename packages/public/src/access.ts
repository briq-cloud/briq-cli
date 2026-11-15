import { z } from 'zod';

/** Explicit admission for synchronous commands. Other transports negotiate separately. */
export const AccessRequest = z
  .object({
    version: z.literal(1),
    operations: z.tuple([z.literal('exec')]),
    maxCommands: z.number().int().min(1).max(16).optional(),
  })
  .strict();
export const AccessDescriptor = z
  .object({
    version: z.literal(1),
    briqId: z.string(),
    region: z.string(),
    origin: z.string().url(),
    operations: z.tuple([z.literal('exec')]),
    transports: z.tuple([z.literal('http')]),
    token: z.string(),
    expiresAt: z.string().datetime(),
    routeGeneration: z.string(),
    /** Reserved command admissions; absent means one. Unused admissions expire. */
    maxCommands: z.number().int().min(1).max(16).optional(),
  })
  .strict();
export type AccessDescriptor = z.infer<typeof AccessDescriptor>;
