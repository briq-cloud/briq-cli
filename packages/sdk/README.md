# @briq-cloud/sdk

The TypeScript client for the [briq](https://briq.cloud) REST API. Run a database, a sandbox or any
OCI image from code.

```bash
npm install @briq-cloud/sdk
```

```ts
import { Briq } from '@briq-cloud/sdk';

const briq = new Briq(process.env.BRIQ_API_KEY!);

const { briqs, outputs, costLine } = await briq.run({ recipe: 'postgres' });
console.log(outputs.DATABASE_URL, costLine);

const result = await briq.exec(briqs[0].id, ['psql', '-U', 'postgres', '-c', 'select 1']);
console.log(result.stdout);

await briq.destroy(briqs[0].id);
```

## Use

| Call | What it does |
| --- | --- |
| `run(input)` | Create a briq from a recipe or an image. |
| `up({ file })` | Bring up the services of a stack file (`briq.yaml`). |
| `exec(id, cmd)` | Run a command in a briq. `execAsync` starts one and returns at once. |
| `putFile`, `getFile` | Write or read a file in a briq. |
| `expose(id, port, mode)` | Give a port a URL, `public` or `private`. |
| `fork(id)` | Start a new briq from a copy of a briq's disk. |
| `stop`, `start`, `destroy` | Change a briq's state. |

Every method maps to one endpoint of the [REST API](https://briq.cloud/docs/api/reference). Each call that
creates briqs carries an `Idempotency-Key` and is sent again after a network error or a 502, 503
or 504, so it makes its briqs once.

### One sandbox

```ts
const briq = new Briq(process.env.BRIQ_API_KEY!);
const { sandbox } = await briq.sandboxStatus('bq_example');
const result = await briq.exec(sandbox.id, ['echo', 'hello']);
```

Set `BRIQ_API_KEY` to the `bq_sbox_…` credential.
Where enabled, it permits safe status, commands, command results/cancellation and files for its exact ID.
Commands and files may wake that sandbox and start billable runtime. Use `sandboxStatus`, not full `status` or `nativeSandbox`.
It cannot create resources, read quota or manage credentials. See the [support matrix](https://briq.cloud/docs/concepts/keys-and-policy#one-sandbox).

## Errors

`create` takes a `size` for that sandbox: `'small'` (the default), `'medium'`, `'large'` or `'xlarge'`
(`SandboxSize`), as long as your plan offers it. Any other value throws `unsupported` before a request.

```ts
const { id } = await sandbox.create({ labels: {}, size: 'medium' });
```

A refusal throws `BriqApiError` with `status`, `code`, `message` and `requestId`.

```ts
import { BriqApiError } from '@briq-cloud/sdk';

try {
  await briq.status('bq_missing');
} catch (err) {
  if (err instanceof BriqApiError && err.status === 404) console.log(err.code, err.requestId);
  else throw err;
}
```

## Sandbox

The same entry runs commands in a sandbox on briq and reads and writes its files. Adapters for other
SDKs build on it.

```ts
import { nativeSandbox } from '@briq-cloud/sdk';

const sandbox = nativeSandbox({ apiKey: process.env.BRIQ_API_KEY! });
const { id } = await sandbox.create({ labels: {} });
await sandbox.exec(id, {
  command: 'echo hello',
  cwd: '/',
  env: {},
  timeoutMs: 10_000,
  onChunk: (chunk) => process.stdout.write(chunk.text),
});
await sandbox.destroy(id);
```

A refusal throws `BriqOperationError` with a `code` (`auth`, `not_found`, `quota`, `timeout`…).
Also exported: `fail`, `files`, `runArgv` and the types `Command`, `CommandResult`, `OutputChunk`,
`FileInfo`, `NativeFiles`, `NativeOptions`, `CreateInput`, `ExecInput`, `SandboxSize` and `OperationCode`.
`CommandResult` is what `runArgv` returns. `ExecResult` is what the client's `exec` returns.

## Options

```ts
new Briq(apiKey, {
  baseUrl: 'http://localhost:3001', // default: https://api.briq.cloud
  fetch: customFetch, // default: the global fetch
});
```

### Regional synchronous commands

A finite synchronous `exec` goes to the regional origin whenever the server returns scoped
access, and to the control API's exec route when the server answers that regional access is
unsupported (before any command is sent). Async commands, files and terminals use the API
routes. There is nothing to configure: a client with a custom `fetch` and no `execution.fetch`
never sends its control credentials to an execution origin, so it stays on the API route.

```ts
const briq = new Briq(apiKey, {
  execution: { fetch: executionFetch, maxCommands: 4 }, // both optional
});
```

`run` also asks for this access in the create request, so the first `exec` on a new briq makes
no separate access call. Pass `{ access: false }` as the second argument of `run` to skip it.
A server that does not return access leaves the first `exec` to ask as before.

With the standard transport, the client reserves up to four command admissions and reuses them
in memory until exhausted or expired. Set `execution.maxCommands` to 1 to disable reuse, or to
an integer up to 16. Unused reservations expire. Each client keeps at most 1024 descriptors;
credentials never go to disk. A custom control transport defaults to one command; reserve more
only when its credential and team context remain fixed for the lifetime of that client.

Asking for access is safe to repeat, since no command has been sent: after a transport error, a
429, 502, 503 or 504 the client asks again (3 attempts in all, waiting 250 ms then 1 s, or the
`Retry-After` when it is at most 5 s). It never runs a command through the API because the
answer is slow. It does so when regional access is not available: the briq has no regional route
(`no_regional_route`, remembered for 10 minutes), the request is refused, or the retries fail
(remembered for 5 s). A command whose connection to the regional origin was refused or not
resolved runs through the API; once its request may have left, it is never sent again and fails
with `outcome_unknown`.

With a custom control `fetch`, supply a separate `execution.fetch` to use regional access.
Otherwise commands use the API route. Keep control credentials out of the
execution transport's defaults. Only the scoped access token is sent to an execution origin.

Access currently reserves one command, so each `exec` obtains fresh access. It is not cached or
shared between concurrent commands. No warm-command latency improvement is claimed by this
negotiation alone.

After a command has been sent, the SDK never retries it through another route. A lost answer,
non-success response or incomplete result throws `BriqApiError` with `code: 'outcome_unknown'`.
The command may have run; inspect its effects before explicitly running it again.

### Many calls at once

Node's `fetch` opens a new connection for each call in flight. A hundred at once can stall on a
home or office network: connects wait, time out after 10 s, and the call is sent again. Cap the
connections with [undici](https://www.npmjs.com/package/undici):

```ts
import { Agent, fetch as undiciFetch } from 'undici';

const pool = new Agent({ connections: 16 });
const briq = new Briq(apiKey, {
  fetch: (url, init) =>
    undiciFetch(url as string, { ...init, dispatcher: pool } as never) as Promise<Response>,
});
```

Calls beyond 16 wait for a free connection. A call that waits for its answer (a create, a long
`exec`) holds one, so raise the cap if you run many of those at once. `nativeSandbox` takes the
same `fetch` option.

Needs Node 22.6 or later; `require('@briq-cloud/sdk')` works on Node 22.12 or later. The package
ships its own types. Its one dependency is `ws`, used by the sandbox layer.

### Native sandbox command routing

```ts
const box = nativeSandbox({
  apiKey,
  eagerChecks: false,
});
await box.run(id, {
  cmd: ['printf', 'hello'], cwd: '/workspace', env: {},
  timeoutMs: 2000, live: false, onChunk: ({ text }) => console.log(text),
});
```

Regional HTTP supports non-live commands without an abort signal, with timeouts from 1 to 60 seconds.
The existing argv, environment, stdin and output bounds still apply.
Streams, files and commands outside these bounds use the API routes.

`eagerChecks` defaults to true. Set `eagerChecks: false` to skip Python readiness; creation still waits for the sandbox to run.
Custom control transports need a separate `execution.fetch`. Only execution grants go to execution origins.
