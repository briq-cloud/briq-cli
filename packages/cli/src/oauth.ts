import { CliError, EXIT, notSignedIn } from './errors.js';

/**
 * `briq login` by link: the OAuth device flow (RFC 8628) briq runs for agents that cannot take a
 * browser redirect. The CLI finds the authorization server from the API, registers
 * itself there (RFC 7591), asks for a code, and polls the token endpoint while the person
 * approves on the dashboard's `/connect`, where they pick the team and the budget. Every step
 * takes a `fetch`, so the tests drive it against the API in process.
 */

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** `briq` to call the API, `offline_access` for a refresh token. */
export const SCOPE = 'briq offline_access';
export const CLIENT_NAME = 'briq CLI';

type Fetch = typeof fetch;

export interface AuthServer {
  issuer: string;
  /** The resource the tokens are for: `<api>/mcp`, as for any MCP client. */
  resource: string;
  deviceEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  /** The page to open, code filled in. */
  link: string;
  /** Seconds between polls. */
  interval: number;
  expiresIn: number;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** RFC 8414 / RFC 9728: the well-known path goes between the origin and the path. */
const wellKnown = (url: string, name: string) => {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}/.well-known/${name}${path}`;
};

const unreachable = (what: string, url: string, detail: string) =>
  new CliError(`could not read the ${what} at ${url}: ${detail}`);

/** The authorization server of an API, from its resource metadata (`<api>/mcp`). */
export async function discover(apiUrl: string, f: Fetch): Promise<AuthServer> {
  const resourceUrl = wellKnown(`${apiUrl}/mcp`, 'oauth-protected-resource');
  const res = await f(resourceUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) throw unreachable('sign-in settings', resourceUrl, `HTTP ${res.status}`);
  const meta = await readJson(res);
  const issuer = str((meta.authorization_servers as unknown[] | undefined)?.[0]);
  const resource = str(meta.resource) || `${apiUrl}/mcp`;
  if (!issuer) throw unreachable('sign-in settings', resourceUrl, 'no authorization server');
  const asUrl = wellKnown(issuer, 'oauth-authorization-server');
  const asRes = await f(asUrl, { headers: { accept: 'application/json' } });
  if (!asRes.ok) throw unreachable('authorization server', asUrl, `HTTP ${asRes.status}`);
  const as = await readJson(asRes);
  const out = {
    issuer: str(as.issuer) || issuer,
    resource,
    deviceEndpoint: str(as.device_authorization_endpoint),
    tokenEndpoint: str(as.token_endpoint),
    registrationEndpoint: str(as.registration_endpoint),
  };
  if (!out.deviceEndpoint || !out.tokenEndpoint || !out.registrationEndpoint)
    throw unreachable('authorization server', asUrl, 'no device sign-in; use `briq login --key`');
  return out;
}

/**
 * The CLI as a public client of this server (no secret, a device that cannot take a redirect),
 * registered at each login, as an agent on a server registers itself.
 */
export async function register(as: AuthServer, version: string, f: Fetch): Promise<string> {
  const res = await f(as.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      software_id: 'briq-cli',
      software_version: version,
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      grant_types: [DEVICE_GRANT, 'refresh_token'],
      scope: SCOPE,
    }),
  });
  const body = await readJson(res);
  if (!res.ok || !str(body.client_id))
    throw new CliError(
      `could not register the CLI with ${as.issuer}: ${str(body.error_description) || str(body.error) || `HTTP ${res.status}`}`,
    );
  return str(body.client_id);
}

/** Ask for a code the person approves on `/connect`. */
export async function requestCode(as: AuthServer, clientId: string, f: Fetch): Promise<DeviceCode> {
  const res = await f(as.deviceEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE, resource: as.resource }),
  });
  const body = await readJson(res);
  if (!res.ok || !str(body.device_code))
    throw new CliError(
      `could not get a sign-in code: ${str(body.error_description) || str(body.error) || `HTTP ${res.status}`}`,
    );
  const userCode = str(body.user_code);
  return {
    deviceCode: str(body.device_code),
    userCode,
    link:
      str(body.verification_uri_complete) ||
      `${str(body.verification_uri)}?user_code=${encodeURIComponent(userCode)}`,
    interval: Number(body.interval) || 5,
    expiresIn: Number(body.expires_in) || 900,
  };
}

function tokensOf(body: Record<string, unknown>, now: number): Tokens {
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: str(body.access_token),
    refreshToken: str(body.refresh_token) || null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
  };
}

const retryAfter = (res: Response, body: Record<string, unknown>) =>
  Number(res.headers.get('retry-after')) || Number(body.retry_after_seconds) || 0;

export interface PollOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Poll until the person approves or refuses on `/connect`, or the code expires. */
export async function pollForTokens(
  as: AuthServer,
  clientId: string,
  code: DeviceCode,
  f: Fetch,
  opts: PollOptions = {},
): Promise<Tokens> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + code.expiresIn * 1000;
  let interval = code.interval;
  for (;;) {
    await sleep(interval * 1000);
    if (now() >= deadline) break;
    let res: Response;
    try {
      res = await f(as.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          device_code: code.deviceCode,
          client_id: clientId,
          resource: as.resource,
        }),
      });
    } catch {
      // The network dropped (a laptop changing Wi-Fi): the code is still good, ask again.
      continue;
    }
    const body = await readJson(res);
    if (res.ok && str(body.access_token)) return tokensOf(body, now());
    if (res.status === 429 || res.status >= 500) {
      interval = Math.max(interval, retryAfter(res, body));
      continue;
    }
    switch (body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5;
        continue;
      case 'access_denied':
        throw new CliError('the sign-in was refused on the approval page', EXIT.auth);
      case 'expired_token':
        throw new CliError(
          'the code expired before it was approved: run `briq login` again',
          EXIT.auth,
        );
      default:
        throw new CliError(
          `sign-in failed: ${str(body.error_description) || str(body.error) || `HTTP ${res.status}`}`,
          EXIT.auth,
        );
    }
  }
  throw new CliError('the code expired before it was approved: run `briq login` again', EXIT.auth);
}

/**
 * A new access token from the refresh token. Refresh tokens rotate: the new one replaces the old,
 * and the caller saves both. A refused refresh means the grant is over (revoked, or 30 days
 * unused).
 */
export async function refreshTokens(
  cred: { tokenEndpoint: string; clientId: string; resource: string; refreshToken: string | null },
  f: Fetch,
  now: () => number = Date.now,
): Promise<Tokens> {
  if (!cred.refreshToken) throw notSignedIn('the sign-in expired: run `briq login` again');
  const res = await f(cred.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cred.refreshToken,
      client_id: cred.clientId,
      resource: cred.resource,
    }),
  });
  const body = await readJson(res);
  if (res.ok && str(body.access_token)) {
    const t = tokensOf(body, now());
    // A server that does not rotate keeps the one we have.
    return { ...t, refreshToken: t.refreshToken ?? cred.refreshToken };
  }
  if (res.status >= 500 || res.status === 429)
    throw new CliError(`could not refresh the sign-in: HTTP ${res.status}, try again`);
  throw notSignedIn('the sign-in was revoked or expired: run `briq login` again');
}
