import { describe, expect, it } from 'vitest';
import { BriqSpec, RecipeFields } from './briq.js';
import { EgressPolicy } from './egress.js';

describe('EgressPolicy', () => {
  it('canonicalizes exact ASCII hostnames without widening them', () => {
    expect(
      EgressPolicy.parse({ hosts: ['API.Example.com', 'example.com', 'api.example.com'] }),
    ).toEqual({ hosts: ['api.example.com', 'example.com'] });
  });

  it('keeps omission unrestricted and an empty list explicitly restricted', () => {
    const spec = { name: 'test', image: 'alpine:3' };
    expect(BriqSpec.parse(spec).egress).toBeUndefined();
    expect(BriqSpec.parse({ ...spec, egress: { hosts: [] } }).egress).toEqual({ hosts: [] });
    expect(RecipeFields.parse({ egress: { hosts: [] } }).egress).toEqual({ hosts: [] });
  });

  it('requires a strict policy object and an explicit hosts list', () => {
    for (const policy of [null, {}, [], { hosts: null }, { hosts: [], mode: 'open' }]) {
      expect(EgressPolicy.safeParse(policy).success).toBe(false);
    }
  });

  it.each([
    '',
    '*',
    '*.example.com',
    'https://example.com',
    'example.com/path',
    'example.com:443',
    'example.com.',
    '.example.com',
    'example..com',
    ' example.com',
    'example.com\n',
    'localhost',
    '127.0.0.1',
    '127.1',
    '2130706433',
    '0177.0.0.1',
    '0x7f.0x0.0x0.0x1',
    '0x7f000001',
    '[::1]',
    '::ffff:127.0.0.1',
    'éxample.com',
    'İ.example.com',
    '-api.example.com',
    'api-.example.com',
    'api_example.com',
    `${'a'.repeat(64)}.example.com`,
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`,
  ])('rejects an ambiguous or malformed host: %s', (host) => {
    expect(EgressPolicy.safeParse({ hosts: [host] }).success).toBe(false);
  });

  it('accepts DNS label and total-length boundaries', () => {
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(host.length).toBe(253);
    expect(EgressPolicy.parse({ hosts: [host] })).toEqual({ hosts: [host] });
  });

  it('bounds the submitted list before deduplication', () => {
    expect(EgressPolicy.parse({ hosts: Array(100).fill('example.com') })).toEqual({
      hosts: ['example.com'],
    });
    expect(EgressPolicy.safeParse({ hosts: Array(101).fill('example.com') }).success).toBe(false);
  });
});
