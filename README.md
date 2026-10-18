# briq CLI

The source of [`@briq-cloud/cli`](https://www.npmjs.com/package/@briq-cloud/cli), the command line
for [briq](https://briq.cloud).

## Install

```bash
npm install -g @briq-cloud/cli
```

How to use it: [packages/cli/README.md](packages/cli/README.md) and the
[CLI reference](https://briq.cloud/docs/cli).

## Packages

| Package | What it is |
| --- | --- |
| `packages/cli` | The `briq` command: one command per MCP tool, bundled into one file |
| `packages/sdk` | The client for briq's REST API that the CLI calls |
| `packages/public` | The API's schemas and types, shared by the CLI and the SDK |

The npm package is the bundle of `packages/cli`. It holds the code of these three packages and
nothing else.

## Build and test

From the root of the repo, with Node 22.6 or later and pnpm:

```bash
pnpm install
pnpm build
pnpm test
```

## Changes

Each release writes this repo again from briq's own repository: a change made here is replaced by
the next release. For a bug or an idea, run `briq feedback bug "…"` or write to
[hello@briq.cloud](mailto:hello@briq.cloud).
