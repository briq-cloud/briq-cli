import { expect, it } from 'vitest';
import { BriqSpec, Healthcheck } from './briq.js';

it('bounds health intervals at the largest representable whole-second period', () => {
  const healthcheck = { cmd: ['true'], intervalMs: 4_294_967_295_000 };
  expect(Healthcheck.parse(healthcheck)).toEqual({ ...healthcheck, timeoutMs: 60_000 });
  expect(
    Healthcheck.safeParse({ ...healthcheck, intervalMs: healthcheck.intervalMs + 1 }).success,
  ).toBe(false);
  expect(BriqSpec.safeParse({ name: 'box', image: 'redis:7', healthcheck }).success).toBe(true);
  expect(
    BriqSpec.safeParse({
      name: 'box',
      image: 'redis:7',
      healthcheck: { ...healthcheck, intervalMs: healthcheck.intervalMs + 1 },
    }).success,
  ).toBe(false);
});
