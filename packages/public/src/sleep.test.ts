import { describe, expect, it } from 'vitest';
import { Sleep, describeSleep, formatSleep, sleepMinutes, sleepsLonger } from './sleep.js';

describe('Sleep', () => {
  it('reads a number and a unit, or never', () => {
    expect(sleepMinutes('30m')).toBe(30);
    expect(sleepMinutes('3h')).toBe(180);
    expect(sleepMinutes('7d')).toBe(10_080);
    expect(sleepMinutes('never')).toBeNull();
    for (const bad of ['30', '0m', '1.5h', '1h30m', ' 1h', '1H', 'forever', ''])
      expect(sleepMinutes(bad)).toBeUndefined();
  });

  it('shows the shortest exact form', () => {
    expect(formatSleep(120)).toBe('2h');
    expect(formatSleep(90)).toBe('90m');
    expect(formatSleep(1440)).toBe('1d');
    expect(formatSleep(null)).toBe('never');
    expect(describeSleep('120m')).toBe('2 hours');
    expect(describeSleep('1d')).toBe('1 day');
    expect(describeSleep('never')).toBe('never');
  });

  it('bounds the window', () => {
    expect(Sleep.safeParse('5m').success).toBe(true);
    expect(Sleep.safeParse('4m').success).toBe(false);
    expect(Sleep.safeParse('7d').success).toBe(true);
    expect(Sleep.safeParse('8d').success).toBe(false);
    expect(Sleep.safeParse('never').success).toBe(true);
  });

  it('refuses a number with the string it meant', () => {
    const r = Sleep.safeParse(30);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(
      'sleep must be a string: "30m", "3h", "7d" or "never". You sent 30, a number. For 30 minutes, pass "30m"',
    );
  });

  it('orders windows, never last', () => {
    expect(sleepsLonger('2h', '90m')).toBe(true);
    expect(sleepsLonger('1d', '1d')).toBe(false);
    expect(sleepsLonger('never', '7d')).toBe(true);
    expect(sleepsLonger('7d', 'never')).toBe(false);
  });
});
