import { expect, it } from 'vitest';
import { BriqSpec, EnvValue } from './briq.js';
it('accepts literal-only markers and exact supplied values', () => {
  for (const value of ['', ' \n雪\t ', '{{briq:missing}} {{secret:missing}} {{self:host}}'])
    expect(EnvValue.parse({ secret: 'constructor', value, literal: true })).toEqual({
      secret: 'constructor',
      value,
      literal: true,
    });
  expect(EnvValue.parse({ secret: '__proto__', literal: true })).toEqual({
    secret: '__proto__',
    literal: true,
  });
  for (const extra of [
    { literal: false },
    { literal: 'true' },
    { literal: true, scope: 'boot' },
    { literal: true, scope: 'team' },
    { literal: true, hosts: ['api.example.com'] },
    { literal: true, locations: ['body'] },
  ])
    expect(EnvValue.safeParse({ secret: 'S', ...extra }).success).toBe(false);
  expect(EnvValue.safeParse({ secret: 'S', value: '{{briq:missing}}' }).success).toBe(false);
});
it('preserves raw own prototype-like keys and uses OS env-name constraints', () => {
  const env = JSON.parse(
    '{"__proto__":{"secret":"__proto__","value":"","literal":true},"constructor":"plain","a b/雪":"yes"}',
  );
  const parsed = BriqSpec.parse({ name: 'box', image: 'alpine', env }).env;
  expect(Object.keys(parsed).sort()).toEqual(Object.keys(env).sort());
  expect(parsed).toEqual(env);
  for (const key of ['', 'a=b', 'a\0b'])
    expect(BriqSpec.safeParse({ name: 'box', image: 'alpine', env: { [key]: 'v' } }).success).toBe(
      false,
    );
  expect(EnvValue.safeParse({ secret: 'S', value: 'a\0b', literal: true }).success).toBe(false);
});

it('counts preserved own keys at the environment bound', () => {
  const env = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`K${i}`, 'v']));
  expect(BriqSpec.safeParse({ name: 'box', image: 'alpine', env }).success).toBe(true);
  expect(
    BriqSpec.safeParse({ name: 'box', image: 'alpine', env: { ...env, ['__proto__']: 'extra' } })
      .success,
  ).toBe(false);
});

it('keeps boot-secret file bindings restricted to portable names', () => {
  expect(
    BriqSpec.safeParse({
      name: 'box',
      image: 'alpine',
      env: { '../escape': { secret: 'S', scope: 'boot' } },
    }).success,
  ).toBe(false);
  expect(
    BriqSpec.safeParse({
      name: 'box',
      image: 'alpine',
      env: { 'a b': { secret: 'S', literal: true } },
    }).success,
  ).toBe(true);
});
