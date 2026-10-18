import { describe, expect, it } from 'vitest';
import { DnsName } from './briq.js';
import { slugify } from './slug.js';

describe('slugify', () => {
  it('makes a DNS label from a name or a git branch', () => {
    expect(slugify('Acme Inc')).toBe('acme-inc');
    expect(slugify('feat/Login_v2')).toBe('feat-login-v2');
    expect(slugify('claude/fix--the.bug')).toBe('claude-fix-the-bug');
    // a cut that lands on a dash drops it
    expect(slugify(`feature/${'a'.repeat(21)}-b`)).toBe(`feature-${'a'.repeat(21)}`);
    for (const s of ['feat/x', 'a'.repeat(200), `x/${'é'.repeat(40)}`, '///'])
      expect(DnsName.safeParse(slugify(s)).success).toBe(true);
  });
});
