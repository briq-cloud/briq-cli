import { z } from 'zod';
import { BriqState } from './briq.js';
import { Size } from './sizes.js';
import { Sleep } from './sleep.js';

export const SandboxStatus = z.object({
  id: z.string(),
  name: z.string(),
  size: Size,
  state: BriqState,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  sleep: Sleep,
  sleepsAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  costCentsSoFar: z.number(),
});
export type SandboxStatus = z.infer<typeof SandboxStatus>;
