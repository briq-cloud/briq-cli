import { describe, expect, it } from 'vitest';
import { BriqLabels, BriqSpec } from './briq.js';

const spec = { name: 'box', image: 'alpine:3' };
describe('control-plane labels', () => {
  it('accepts portable SDK keys and preserves omitted/empty legacy specs', () => {
    const labels = { 'sandbox-sdk': '1', 'sdk/key': 'a key:雪', empty: '' };
    expect(BriqSpec.parse({ ...spec, labels }).labels).toEqual(labels);
    expect(JSON.stringify(BriqSpec.parse({ ...spec, labels: {} }))).toBe(
      JSON.stringify(BriqSpec.parse(spec)),
    );
    expect(BriqSpec.parse(spec).labels).toBeUndefined();
  });

  it('rejects JSON own __proto__ keys before parsing or counting transformed records', () => {
    const dropped = JSON.parse('{"__proto__":"must not disappear"}');
    expect(Object.hasOwn(dropped, '__proto__')).toBe(true);
    expect(BriqLabels.safeParse(dropped).success).toBe(false);
    const thirtyTwo = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, 'v']));
    const thirtyThree = JSON.parse(JSON.stringify({ ...thirtyTwo, ['__proto__']: 'extra' }));
    expect(Object.keys(thirtyThree)).toHaveLength(33);
    const rejected = BriqLabels.safeParse(thirtyThree);
    expect(rejected.success).toBe(false);
    if (!rejected.success)
      expect(rejected.error.issues.map((issue) => issue.message)).toContain('at most 32 labels');
    expect(BriqLabels.parse(JSON.parse(JSON.stringify(thirtyTwo)))).toEqual(thirtyTwo);
  });

  it('bounds count, key/value lengths and encoded size', () => {
    for (const labels of [
      { '': 'x' },
      { ['k'.repeat(129)]: 'x' },
      { key: 'v'.repeat(1025) },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, ''])),
      Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, '雪'.repeat(1024)])),
      { key: 1 },
    ])
      expect(BriqLabels.safeParse(labels).success).toBe(false);
    expect(BriqLabels.safeParse({ ['k'.repeat(128)]: 'v'.repeat(1024) }).success).toBe(true);
  });
});
