import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * What `briq login` keeps: one file in the config directory, readable by its owner only, holding
 * one credential and the API it belongs to.
 */

/** An API key, from `briq login --key`. */
export interface KeyCredential {
  kind: 'key';
  key: string;
}

/** An agent grant from `briq login` (the OAuth device flow). */
export interface OAuthCredential {
  kind: 'oauth';
  clientId: string;
  tokenEndpoint: string;
  /** The resource the tokens are bound to (`<api>/mcp`). */
  resource: string;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds; null when the server did not say. */
  expiresAt: number | null;
}

export type StoredCredential = KeyCredential | OAuthCredential;

export interface Config {
  /** The API the credential belongs to; `BRIQ_API_URL` wins over it. */
  apiUrl?: string;
  credential?: StoredCredential;
}

export const DEFAULT_API_URL = 'https://api.briq.cloud';

export const configDir = () =>
  process.env.BRIQ_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'briq');
export const configFile = () => join(configDir(), 'config.json');

/** `https://api.briq.cloud/` and `https://api.briq.cloud` are one API. */
export const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, '');

export function loadConfig(): Config {
  const file = configFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Config;
  } catch {
    throw new Error(`${file} is not valid JSON: delete it, then run \`briq login\``);
  }
}

/**
 * Written whole, to a temporary file renamed over the old one: a process killed mid-write leaves
 * the previous file, never half of one. Mode 600 from the first byte, the directory 700.
 */
export function saveConfig(cfg: Config) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const file = configFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  // The mode a file is created with passes through the umask; set it again.
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

/** The API this run talks to: `BRIQ_API_URL`, else the saved one, else production. */
export const apiUrlOf = (cfg: Config) =>
  normalizeUrl(process.env.BRIQ_API_URL || cfg.apiUrl || DEFAULT_API_URL);

/** What a command signs its calls with. `BRIQ_API_KEY` wins over the saved credential. */
export type Resolved =
  | { source: 'env'; credential: KeyCredential }
  | { source: 'file'; credential: StoredCredential }
  | { source: 'none'; credential: null };

export function resolveCredential(cfg: Config, opts: { env?: boolean } = {}): Resolved {
  const env = opts.env === false ? '' : process.env.BRIQ_API_KEY?.trim();
  if (env) return { source: 'env', credential: { kind: 'key', key: env } };
  // A credential is good for the API it was made for only.
  const savedFor = normalizeUrl(cfg.apiUrl || DEFAULT_API_URL);
  if (cfg.credential && savedFor === apiUrlOf(cfg))
    return { source: 'file', credential: cfg.credential };
  return { source: 'none', credential: null };
}

/** Which environment an API is, named as the dashboard names them. */
export function environmentOf(apiUrl: string): 'production' | 'staging' | 'local' {
  let host = '';
  try {
    host = new URL(apiUrl).hostname.toLowerCase();
  } catch {}
  if (host === 'api.briq.cloud') return 'production';
  if (host === 'api.stg.briq.cloud') return 'staging';
  return 'local';
}
