import { z } from 'zod';

/** A briq's machine size: CPUs and memory, and its price per hour (https://briq.cloud/pricing). */
export const Size = z.enum(['pico', 'micro', 'nano', 'small', 'medium', 'large', 'xlarge']);
export type Size = z.infer<typeof Size>;
