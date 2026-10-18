/**
 * Placeholders in a plain env value, put in when the briq is created: `{{briq:NAME}}` (the address
 * of the briq NAME in the stack), `{{secret:NAME}}` (the value of a secret of the stack) and
 * `{{self:host}}` (the briq's own public hostname). They compose inside a larger value:
 * `postgres://app:{{secret:PGPASSWORD}}@{{briq:db}}:5432/app`.
 */

/** Matches `{{briq:name}}`; `name` follows DnsName, so no escaping is needed. */
const REF = /\{\{briq:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\}\}/g;

/** Placeholder for a sibling briq's address, resolved when the briq is created. */
export function briqRef(name: string): string {
  return `{{briq:${name}}}`;
}

/** Every briq named by a placeholder anywhere in these values, de-duplicated. */
export function refsIn(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const v of values) for (const m of v.matchAll(REF)) out.add(m[1] as string);
  return [...out];
}

/**
 * Replace every placeholder with the address from `hosts`. A name with no entry is left as-is:
 * a half-substituted connection string that fails loudly beats one silently pointing at "".
 */
export function substituteRefs(value: string, hosts: Map<string, string>): string {
  return value.replace(REF, (whole, name: string) => hosts.get(name) ?? whole);
}

/** Matches `{{secret:NAME}}`; NAME follows EnvName. */
const SECRET_REF = /\{\{secret:([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g;

/**
 * Every secret named by `{{secret:NAME}}` in these values: a secret of the briq itself or of a
 * briq of its stack, inside a larger plain value (`postgres://app:{{secret:PGPASSWORD}}@…`).
 * The value is put in at create, into the machine's env only: the spec, and status, keep the
 * placeholder.
 */
export function secretRefsIn(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const v of values) for (const m of v.matchAll(SECRET_REF)) out.add(m[1] as string);
  return [...out];
}

/** Replace each `{{secret:NAME}}` found in `values`; an unknown NAME is left as it is. */
export function substituteSecretRefs(value: string, values: Record<string, string>): string {
  return value.replace(SECRET_REF, (whole, name: string) => values[name] ?? whole);
}

/**
 * Placeholder for the briq's own public hostname, for an app that writes its domain into its links
 * at boot. It is the URL of a briq published as it is created (`expose` on `briq_run`); without
 * one, `localhost`.
 */
export const SELF_HOST = '{{self:host}}';

export function substituteSelfHost(value: string, host: string): string {
  return value.replaceAll(SELF_HOST, host);
}
