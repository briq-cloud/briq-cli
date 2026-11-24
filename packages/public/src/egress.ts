import { z } from 'zod';

const EgressHost = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/, 'must be an ASCII hostname')
  .refine((host) => {
    const labels = host.split('.');
    const last = labels.at(-1) ?? '';
    return (
      labels.length > 1 &&
      labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
      !/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(last)
    );
  }, 'must be an exact hostname without a wildcard, IP address, port or trailing dot')
  .transform((host) => host.toLowerCase());

export const EgressPolicy = z
  .object({
    hosts: z
      .array(EgressHost)
      .max(100)
      .transform((hosts) => [...new Set(hosts)].sort()),
  })
  .strict()
  .describe(
    'Restrict outbound HTTPS on port 443 to these exact hostnames. An empty hosts list denies all. Standalone sandboxes only; requires a supporting runtime',
  );
export type EgressPolicy = z.infer<typeof EgressPolicy>;
