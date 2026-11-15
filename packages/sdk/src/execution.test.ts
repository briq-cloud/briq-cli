import { afterEach, describe, expect, it, vi } from 'vitest';
import { Briq } from './index.js';

const result = {
  stdout: 'done',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  truncated: false,
  costLine: 'current cost',
};
const descriptor = () => ({
  version: 1,
  briqId: 'bq_one',
  origin: 'https://commands.example',
  region: 'region-one',
  operations: ['exec'],
  transports: ['http'],
  token: 'scoped-token',
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
  routeGeneration: 'generation-one',
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'x-request-id': 'request-one' } });
const error = (status: number, code: string) => json({ error: { code, message: code } }, status);

afterEach(() => vi.unstubAllGlobals());

describe('synchronous execution routing', () => {
  it('uses the API route with a custom control fetch and no execution fetch, without discovery', async () => {
    const control = vi.fn<typeof fetch>().mockResolvedValue(json(result));
    expect(await new Briq('control-token', { fetch: control }).exec('bq_one', ['true'])).toEqual(
      result,
    );
    expect(control).toHaveBeenCalledTimes(1);
    expect(control.mock.calls[0]?.[0]).toBe('https://api.briq.cloud/v1/briqs/bq_one/exec');
  });

  it('isolates control credentials, execution credentials and transport options', async () => {
    const control = vi.fn<typeof fetch>().mockImplementation(async () => json(descriptor()));
    const execution = vi.fn<typeof fetch>().mockImplementation(async () => json(result));
    const client = new Briq('control-token', {
      baseUrl: 'https://self-hosted.example',
      fetch: control,
      execution: { fetch: execution },
    });
    expect(await client.exec('bq_one', ['echo', 'hi'], { env: { NAME: 'value' } })).toEqual(result);
    const [controlUrl, admission] = control.mock.calls[0]!;
    expect(controlUrl).toBe('https://self-hosted.example/v1/briqs/bq_one/access');
    expect(new Headers(admission?.headers).get('authorization')).toBe('Bearer control-token');
    expect(JSON.parse(String(admission?.body))).toEqual({ version: 1, operations: ['exec'] });
    expect(admission).toMatchObject({ redirect: 'error', cache: 'no-store' });
    expect(admission?.signal).toBeInstanceOf(AbortSignal);
    const [executionUrl, command] = execution.mock.calls[0]!;
    expect(executionUrl).toBe('https://commands.example/v1/briqs/bq_one/exec');
    expect(new Headers(command?.headers).get('authorization')).toBe('Bearer scoped-token');
    expect(JSON.stringify(command)).not.toContain('control-token');
    expect(JSON.parse(String(command?.body))).toEqual({
      cmd: ['echo', 'hi'],
      env: { NAME: 'value' },
    });
    expect(command).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    expect(command?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the global execution transport only when the control transport is also global', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).endsWith('/access') ? json(descriptor()) : json(result),
      );
    vi.stubGlobal('fetch', network);
    await new Briq('control-token', { execution: {} }).exec('bq_one', ['true']);
    expect(network.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.briq.cloud/v1/briqs/bq_one/access',
      'https://commands.example/v1/briqs/bq_one/exec',
    ]);
  });

  it('preserves custom control fetch boundaries', async () => {
    const control = vi.fn<typeof fetch>().mockImplementation(async () => json(result));
    const external = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', external);
    await expect(
      new Briq('control-token', { fetch: control }).exec('bq_one', ['true']),
    ).resolves.toEqual(result);
    expect(control).toHaveBeenCalledTimes(1);
    expect(String(control.mock.calls[0]?.[0])).toMatch(/\/exec$/);
    expect(external).not.toHaveBeenCalled();
  });

  it.each([404, 405, 501, 503])(
    'falls back to the API route before dispatch on unsupported discovery (%s)',
    async (status) => {
      const control = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url) =>
          String(url).endsWith('/access') ? error(status, 'provider_error') : json(result),
        );
      const execution = vi.fn<typeof fetch>();
      await expect(
        new Briq('key', { fetch: control, execution: { fetch: execution } }).exec('bq_one', [
          'true',
        ]),
      ).resolves.toEqual(result);
      expect(control).toHaveBeenCalledTimes(2);
      expect(execution).not.toHaveBeenCalled();
    },
  );

  it.each([401, 402, 403, 409, 429])(
    'does not bypass an admission refusal (%s)',
    async (status) => {
      const control = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => error(status, 'refused'));
      const execution = vi.fn<typeof fetch>();
      await expect(
        new Briq('key', { fetch: control, execution: { fetch: execution } }).exec('bq_one', [
          'true',
        ]),
      ).rejects.toMatchObject({ status });
      expect(control).toHaveBeenCalledTimes(1);
      expect(execution).not.toHaveBeenCalled();
    },
  );

  it.each([
    { origin: 'http://commands.example' },
    { origin: 'https://user:password@commands.example' },
    { origin: 'https://commands.example/path' },
    { origin: 'https://commands.example?token=x' },
    { origin: 'https://commands.example/' },
    { briqId: 'bq_other' },
    { version: 2 },
    { operations: ['shell'] },
    { transports: ['websocket'] },
    { token: 'bad\nheader' },
    { routeGeneration: '' },
    { expiresAt: 'invalid' },
    { expiresAt: new Date(0).toISOString() },
    { expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  ])('refuses an invalid descriptor without sending a command: %j', async (change) => {
    const control = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({ ...descriptor(), ...change }));
    const execution = vi.fn<typeof fetch>();
    await expect(
      new Briq('key', { fetch: control, execution: { fetch: execution } }).exec('bq_one', ['true']),
    ).rejects.toMatchObject({ code: 'invalid_access' });
    expect(control).toHaveBeenCalledTimes(1);
    expect(execution).not.toHaveBeenCalled();
  });

  it.each([
    'network',
    'redirect',
    'server',
    'malformed-refusal',
    'unproven-refusal',
    'invalid-json',
    'missing-terminal',
    'body-read',
  ] as const)('never replays a command after an uncertain %s failure', async (failure) => {
    const control = vi.fn<typeof fetch>().mockImplementation(async () => json(descriptor()));
    const execution = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (failure === 'network' || failure === 'redirect')
        throw new TypeError('private transport detail');
      if (failure === 'server') return error(503, 'provider_error');
      if (failure === 'malformed-refusal')
        return new Response('<html>timeout</html>', { status: 408 });
      if (failure === 'unproven-refusal') return error(401, 'unauthorized');
      if (failure === 'invalid-json') return new Response('not-json');
      if (failure === 'missing-terminal') return json({ stdout: 'partial' });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('private body detail'));
          },
        }),
      );
    });
    await expect(
      new Briq('control-token', {
        fetch: control,
        execution: { fetch: execution },
      }).exec('bq_one', ['true']),
    ).rejects.toMatchObject({
      code: 'outcome_unknown',
      message: 'the command may have run; it was not sent again',
    });
    expect(control).toHaveBeenCalledTimes(1);
    expect(execution).toHaveBeenCalledTimes(1);
  });

  it('obtains independent access for each concurrent command instead of sharing one reserved unit', async () => {
    let issued = 0;
    const control = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({ ...descriptor(), token: `token-${++issued}` }));
    const execution = vi.fn<typeof fetch>().mockImplementation(async () => json(result));
    const client = new Briq('key', {
      fetch: control,
      execution: { fetch: execution },
    });
    await Promise.all([client.exec('bq_one', ['true']), client.exec('bq_one', ['true'])]);
    expect(control).toHaveBeenCalledTimes(2);
    expect(
      new Set(
        execution.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')),
      ),
    ).toEqual(new Set(['Bearer token-1', 'Bearer token-2']));
  });

  it('cancels an unproven failure response instead of retaining its body', async () => {
    const cancel = vi.fn();
    const control = vi.fn<typeof fetch>().mockImplementation(async () => json(descriptor()));
    const execution = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(new ReadableStream({ cancel }), { status: 503 }),
      );
    await expect(
      new Briq('key', {
        fetch: control,
        execution: { fetch: execution },
      }).exec('bq_one', ['true']),
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps async and terminal operations central without exposing an access token', async () => {
    const control = vi.fn<typeof fetch>().mockImplementation(async () => json({}));
    const execution = vi.fn<typeof fetch>();
    const client = new Briq('control-token', {
      baseUrl: 'https://control.example',
      fetch: control,
      execution: { fetch: execution },
    });
    await client.execAsync('bq_one', ['true']);
    expect(String(control.mock.calls[0]?.[0])).toBe('https://control.example/v1/briqs/bq_one/exec');
    expect(JSON.parse(String(control.mock.calls[0]?.[1]?.body)).async).toBe(true);
    expect(client.shellHandshake('bq_one').url).toBe('wss://control.example/v1/briqs/bq_one/shell');
    expect(execution).not.toHaveBeenCalled();
  });
});

describe('bounded reusable execution access', () => {
  function client(maxCommands = 4) {
    let issued = 0;
    const control = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        json({ ...descriptor(), token: `grant-${++issued}`, maxCommands }),
      );
    const execution = vi.fn<typeof fetch>().mockImplementation(async () => json(result));
    return {
      control,
      execution,
      sdk: new Briq('key', {
        fetch: control,
        execution: { fetch: execution, maxCommands },
      }),
    };
  }
  it('runs four concurrent commands with one central admission and reserves again for the fifth', async () => {
    const { sdk, control, execution } = client();
    await Promise.all(
      Array.from({ length: 4 }, () => sdk.exec('bq_one', ['true'], { timeoutMs: 1000 })),
    );
    expect(control).toHaveBeenCalledTimes(1);
    expect(execution).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(control.mock.calls[0]![1]!.body))).toEqual({
      version: 1,
      operations: ['exec'],
      maxCommands: 4,
    });
    expect(
      execution.mock.calls.every(
        ([, init]) => new Headers(init!.headers).get('authorization') === 'Bearer grant-1',
      ),
    ).toBe(true);
    await sdk.exec('bq_one', ['true'], { timeoutMs: 1000 });
    expect(control).toHaveBeenCalledTimes(2);
    expect(new Headers(execution.mock.calls[4]![1]!.headers).get('authorization')).toBe(
      'Bearer grant-2',
    );
  });
  it('never reuses a descriptor across briqs or client credentials', async () => {
    const { sdk, control } = client();
    control.mockImplementation(async (url) =>
      json({
        ...descriptor(),
        briqId: String(url).includes('bq_two') ? 'bq_two' : 'bq_one',
        maxCommands: 4,
      }),
    );
    await sdk.exec('bq_one', ['true']);
    await sdk.exec('bq_two', ['true']);
    expect(control).toHaveBeenCalledTimes(2);
    const other = client();
    await other.sdk.exec('bq_one', ['true']);
    expect(other.control).toHaveBeenCalledTimes(1);
  });
  it('discards all remaining capacity after an uncertain dispatch without retrying that command', async () => {
    const { sdk, control, execution } = client();
    execution.mockRejectedValueOnce(new Error('connection lost'));
    await expect(sdk.exec('bq_one', ['side-effect'])).rejects.toMatchObject({
      code: 'outcome_unknown',
    });
    expect(execution).toHaveBeenCalledTimes(1);
    await sdk.exec('bq_one', ['different-command']);
    expect(control).toHaveBeenCalledTimes(2);
    expect(execution).toHaveBeenCalledTimes(2);
  });
  it('refreshes expired access without dispatching the cached credential', async () => {
    const { sdk, control, execution } = client();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await sdk.exec('bq_one', ['true']);
      clock.mockReturnValue(now + 31_000);
      await sdk.exec('bq_one', ['true']);
      expect(control).toHaveBeenCalledTimes(2);
      expect(new Headers(execution.mock.calls[1]![1]!.headers).get('authorization')).toBe(
        'Bearer grant-2',
      );
    } finally {
      clock.mockRestore();
    }
  });
  it('negotiates a legacy discovery shape once and keeps legacy descriptors single use', async () => {
    const { sdk, control } = client();
    control
      .mockResolvedValueOnce(error(400, 'validation'))
      .mockImplementation(async () => json(descriptor()));
    await sdk.exec('bq_one', ['true']);
    await sdk.exec('bq_one', ['true']);
    expect(control).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(control.mock.calls[0]![1]!.body)).maxCommands).toBe(4);
    expect(JSON.parse(String(control.mock.calls[1]![1]!.body))).not.toHaveProperty('maxCommands');
    expect(JSON.parse(String(control.mock.calls[2]![1]!.body))).not.toHaveProperty('maxCommands');
  });
  it('negotiates both already-sent discoveries when distinct briqs hit a legacy API concurrently', async () => {
    const { sdk, control, execution } = client();
    control.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.maxCommands !== undefined) return error(400, 'validation');
      return json({
        ...descriptor(),
        briqId: String(url).includes('bq_two') ? 'bq_two' : 'bq_one',
      });
    });
    await expect(
      Promise.all([sdk.exec('bq_one', ['true']), sdk.exec('bq_two', ['true'])]),
    ).resolves.toHaveLength(2);
    expect(control).toHaveBeenCalledTimes(4);
    expect(execution).toHaveBeenCalledTimes(2);
  });
  it('rejects unreserved or malformed capacity claims', async () => {
    for (const maxCommands of [0, 5, 1.5, null]) {
      const { sdk, control, execution } = client();
      control.mockResolvedValue(json({ ...descriptor(), maxCommands }));
      await expect(sdk.exec('bq_one', ['true'])).rejects.toMatchObject({ code: 'invalid_access' });
      expect(execution).not.toHaveBeenCalled();
    }
  });
});

describe('access carried by the create answer', () => {
  const created = (access?: unknown) => ({
    briqs: [{ id: 'bq_one' }],
    outputs: {},
    recipe: null,
    costLine: 'cost',
    ready: true,
    ...(access ? { access } : {}),
  });
  const spec = { spec: { image: 'redis:7' } } as never;
  function setup(answer: unknown) {
    const control = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).endsWith('/access')
          ? json({ ...descriptor(), token: 'from-access' })
          : json(answer, 201),
      );
    const execution = vi.fn<typeof fetch>().mockImplementation(async () => json(result));
    return {
      control,
      execution,
      sdk: new Briq('key', {
        fetch: control,
        execution: { fetch: execution, maxCommands: 4 },
      }),
    };
  }
  const sentBody = (f: ReturnType<typeof vi.fn<typeof fetch>>) =>
    JSON.parse(String(f.mock.calls[0]![1]!.body));

  it('ignores a grant for a briq the create did not make', async () => {
    const other = { ...descriptor(), briqId: 'bq_other', token: 'stranger' };
    const { sdk, control, execution } = setup(created({ bq_other: other }));
    await sdk.run(spec);
    await sdk.exec('bq_other', ['true']).catch(() => {});
    expect(control.mock.calls.map(([url]) => String(url)).some((u) => u.endsWith('/access'))).toBe(
      true,
    );
    expect(execution).not.toHaveBeenCalled();
  });

  it('asks for access, keeps it for the first command and never returns it', async () => {
    const grant = { ...descriptor(), token: 'from-create', maxCommands: 4 };
    const { sdk, control, execution } = setup(created({ bq_one: grant }));
    const run = await sdk.run(spec);
    expect(sentBody(control).access).toEqual({
      version: 1,
      operations: ['exec'],
      maxCommands: 4,
    });
    expect(JSON.stringify(run)).not.toContain('from-create');
    expect(run).not.toHaveProperty('access');
    await sdk.exec('bq_one', ['true']);
    expect(control).toHaveBeenCalledTimes(1);
    expect(new Headers(execution.mock.calls[0]![1]!.headers).get('authorization')).toBe(
      'Bearer from-create',
    );
  });

  it('asks for its own access when the create answered without any', async () => {
    const { sdk, control } = setup(created());
    await sdk.run(spec);
    await sdk.exec('bq_one', ['true']);
    expect(control.mock.calls.map(([url]) => String(url)).at(-1)).toMatch(/\/access$/);
  });

  it('drops invalid access instead of using it', async () => {
    const bad = { ...descriptor(), origin: 'http://commands.example', token: 'from-create' };
    const { sdk, control, execution } = setup(created({ bq_one: bad }));
    await sdk.run(spec);
    await sdk.exec('bq_one', ['true']);
    expect(control).toHaveBeenCalledTimes(2);
    expect(new Headers(execution.mock.calls[0]![1]!.headers).get('authorization')).toBe(
      'Bearer from-access',
    );
  });

  it('asks for new access once the one from the create has expired', async () => {
    const grant = { ...descriptor(), token: 'from-create' };
    const { sdk, control, execution } = setup(created({ bq_one: grant }));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await sdk.run(spec);
      clock.mockReturnValue(now + 31_000);
      await sdk.exec('bq_one', ['true']);
      expect(control).toHaveBeenCalledTimes(2);
      expect(new Headers(execution.mock.calls[0]![1]!.headers).get('authorization')).toBe(
        'Bearer from-access',
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('sends the create again without access to an API that refuses the field', async () => {
    const control = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(error(400, 'validation'))
      .mockImplementation(async () => json(created(), 201));
    const sdk = new Briq('key', {
      fetch: control,
      execution: { fetch: vi.fn<typeof fetch>() },
    });
    expect((await sdk.run(spec)).ready).toBe(true);
    expect(JSON.parse(String(control.mock.calls[1]![1]!.body))).not.toHaveProperty('access');
    await sdk.run(spec);
    expect(JSON.parse(String(control.mock.calls[2]![1]!.body))).not.toHaveProperty('access');
  });
});
