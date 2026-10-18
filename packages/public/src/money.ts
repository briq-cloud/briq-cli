import { z } from 'zod';

/**
 * Every amount is **euro cents**, fractions of a cent included: a `nano` costs 1 cent an hour, so
 * a second of it is 0.000278 cents. Other currencies are for display, at a rate the API serves
 * with the prices (`GET /v1/pricing`).
 */

export const Currency = z.enum(['eur', 'usd']);
export type Currency = z.infer<typeof Currency>;

/** The currency every amount is in. */
export const BILLING_CURRENCY: Currency = 'eur';

export const CURRENCY_INFO: Record<Currency, { symbol: string; label: string; code: string }> = {
  eur: { symbol: '€', label: 'Euro', code: 'EUR' },
  usd: { symbol: '$', label: 'US dollar', code: 'USD' },
};

/** How to show an amount: the currency and one euro in it. */
export interface Display {
  currency: Currency;
  rate: number;
}

/** Euro as it is: no conversion. */
export const EUR_DISPLAY: Display = { currency: BILLING_CURRENCY, rate: 1 };

/** Euro cents as cents of the display currency. */
export function convertCents(eurCents: number, display: Display = EUR_DISPLAY): number {
  return eurCents * display.rate;
}

/**
 * Euro cents as text in `currency`: `€0.03`, `€0.006`, `€0.00034`, `$5.85`.
 *
 * Small amounts keep their precision: at least two decimals, and enough of them to show two
 * significant digits (six at most), trailing zeros dropped past the second. From one unit up, two
 * decimals: `€1.234` reads `€1.23`.
 */
export function formatMoney(
  eurCents: number,
  display: Display = EUR_DISPLAY,
  opts: { decimals?: number } = {},
): string {
  const units = convertCents(eurCents, display) / 100;
  const abs = Math.abs(units);
  const decimals =
    opts.decimals ??
    (abs === 0 || abs >= 1 ? 2 : Math.min(6, Math.max(2, 1 - Math.floor(Math.log10(abs)))));
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: Math.min(2, decimals),
    maximumFractionDigits: decimals,
  });
  return `${units < 0 ? '-' : ''}${CURRENCY_INFO[display.currency].symbol}${text}`;
}
