import { z } from 'zod';

/** What a message to the briq team is about (`briq_feedback`, `POST /v1/support`). */
export const SupportTopic = z.enum(['question', 'bug', 'idea']);
export type SupportTopic = z.infer<typeof SupportTopic>;
