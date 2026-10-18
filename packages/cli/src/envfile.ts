import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Writing a fork's outputs into a dotenv file (`briq fork --env .env.local`). The file is the
 * person's: the keys briq writes are replaced where they are, every other line is kept as it was,
 * and keys it did not have yet go at the end under one `# briq:` line. A new file is created
 * readable by its owner only, since the values hold passwords.
 */

/** An output key as an env name: `db:DATABASE_URL` (two databases, see `forkOutputs`) → `DB_DATABASE_URL`. */
export const envName = (key: string) => key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();

/**
 * A dotenv value: bare when it is plain. Otherwise quoted so that no reader expands it: dotenv-expand,
 * Next.js and Compose read `$NAME` inside double quotes, and a password can hold a `$`. Single
 * quotes are literal everywhere; a value that needs them (a `'`, a newline) is double-quoted with
 * `\`, `"`, `$` and newlines escaped.
 */
export function envValue(v: string): string {
  if (/^[A-Za-z0-9_./:@%+,=?&-]*$/.test(v)) return v;
  if (!v.includes("'") && !v.includes('\n')) return `'${v}'`;
  return `"${v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')}"`;
}

const KEY = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const MARK = /^# briq: /;

/** `text` (a dotenv file, or null for none) with `values` written in. */
export function mergeEnv(text: string | null, values: Record<string, string>, note: string) {
  const vals = new Map(Object.entries(values).map(([k, v]) => [envName(k), envValue(v)]));
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    if (MARK.test(line)) return `# briq: ${note}`;
    const m = KEY.exec(line);
    const key = m?.[2];
    if (!key || !vals.has(key)) return line;
    seen.add(key);
    // `export KEY=` stays exported: the file may be sourced by a shell.
    return `${m?.[1] ?? ''}${key}=${vals.get(key)}`;
  });
  const added = [...vals].filter(([k]) => !seen.has(k));
  if (added.length) {
    if (!out.some((l) => MARK.test(l))) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(`# briq: ${note}`);
    }
    for (const [k, v] of added) out.push(`${k}=${v}`);
  }
  return `${out.join('\n')}\n`;
}

/** Write `values` into the dotenv file at `path`: created with mode 600, merged otherwise. */
export function writeEnv(path: string, values: Record<string, string>, note: string) {
  const had = existsSync(path);
  const text = mergeEnv(had ? readFileSync(path, 'utf8') : null, values, note);
  // `wx` on a new file: never truncate one that appeared since, and 600 from the first byte
  writeFileSync(path, text, had ? {} : { mode: 0o600, flag: 'wx' });
}
