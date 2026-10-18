import { readFileSync } from 'node:fs';
import { Briq } from '@briq/sdk';
import {
  type Config,
  type Resolved,
  apiUrlOf,
  loadConfig,
  resolveCredential,
  saveConfig,
} from './config.js';
import { notSignedIn } from './errors.js';
import { refreshTokens } from './oauth.js';

/** This package's version, read from its package.json (one directory up from `dist/` or `src/`). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** How the API knows the CLI: audit rows and the Agents page name it `briq-cli`. */
export const USER_AGENT = `briq-cli/${VERSION} (node/${process.versions.node}; ${process.platform})`;

/**
 * Refresh an access token once it has this long left. Tokens last 30 days and the refresh token
 * expires with them unless used, so a CLI used at least every two weeks stays signed in.
 */
const REFRESH_AHEAD_MS = 15 * 24 * 3600_000;

/** `fetch` with the CLI's User-Agent on every request, the sign-in calls included. */
export const cliFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set('user-agent', USER_AGENT);
  return fetch(input, { ...init, headers });
};

export interface Session {
  apiUrl: string;
  config: Config;
  resolved: Resolved;
  client: Briq;
}

/**
 * The API client for this run. With a sign-in by link, the access token is refreshed first when
 * it has less than 15 days left, and the new pair saved at once: refresh tokens rotate.
 */
export async function openSession(): Promise<Session> {
  const config = loadConfig();
  const apiUrl = apiUrlOf(config);
  const resolved = resolveCredential(config);
  const cred = resolved.credential;
  if (!cred)
    throw notSignedIn(
      `not signed in to ${apiUrl}: run \`briq login\` (or \`briq login --key\`), or set BRIQ_API_KEY`,
    );
  if (
    cred.kind === 'oauth' &&
    cred.expiresAt !== null &&
    cred.expiresAt - Date.now() < REFRESH_AHEAD_MS
  ) {
    Object.assign(cred, await refreshTokens(cred, cliFetch));
    saveConfig(config);
  }
  const token = cred.kind === 'key' ? cred.key : cred.accessToken;
  return {
    apiUrl,
    config,
    resolved,
    client: new Briq(token, { baseUrl: apiUrl, fetch: cliFetch }),
  };
}
