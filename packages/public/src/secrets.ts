import { z } from 'zod';
import { EnvName, MAX_ENV_VALUE, SecretHost, SecretLocation } from './briq.js';

/**
 * Team secrets: a credential the team's briqs use without ever holding it. The value
 * is stored encrypted, the briq's environment gets a placeholder, and the team's credential gateway swaps
 * the real value in on the way out, to the hosts the secret allows, in the places it allows.
 */

export const MAX_TEAM_SECRETS = 50;

export const TeamSecretIn = z
  .object({
    name: EnvName.describe('How briqs refer to it: { secret: "GITHUB_TOKEN", scope: "team" }'),
    value: z.string().min(1).max(MAX_ENV_VALUE).describe('The credential. Write-only'),
    hosts: z
      .array(SecretHost)
      .min(1)
      .max(20)
      .describe('The hosts it may be sent to; nothing else ever sees it'),
    locations: z
      .array(SecretLocation)
      .min(1)
      .default(['header'])
      .describe('Where it is put in: "header" (the usual), "body" for a form or JSON field'),
  })
  .strict();
export type TeamSecretIn = z.infer<typeof TeamSecretIn>;

export const TeamSecretUpdate = z
  .object({
    value: z.string().min(1).max(MAX_ENV_VALUE).optional().describe('A new value: a rotation'),
    hosts: z.array(SecretHost).min(1).max(20).optional(),
    locations: z.array(SecretLocation).min(1).optional(),
  })
  .strict();
export type TeamSecretUpdate = z.infer<typeof TeamSecretUpdate>;

/** A team secret as the API shows it: never its value, never its placeholder. */
export const TeamSecretOut = z.object({
  id: z.string(),
  name: z.string(),
  hosts: z.array(z.string()),
  locations: z.array(SecretLocation),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type TeamSecretOut = z.infer<typeof TeamSecretOut>;
