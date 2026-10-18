# briq CLI source

The source of [`@briq-cloud/cli`](https://www.npmjs.com/package/@briq-cloud/cli), the command line
for [briq](https://briq.cloud). Each release is published to npm from this repo, with
[provenance](https://docs.npmjs.com/generating-provenance-statements): the npm page links the
commit and the workflow run that built it.

```bash
npm install -g @briq-cloud/cli
```

How to use it: [packages/cli/README.md](packages/cli/README.md) and
[briq.cloud/docs/cli](https://briq.cloud/docs/cli).

## What is here

| Package | What it is |
| --- | --- |
| `packages/cli` | The `briq` command. One command per MCP tool, bundled into one file |
| `packages/sdk` | The client for briq's REST API that the CLI calls |
| `packages/public` | The API's schemas and types the CLI and the SDK share with it |

The npm package is `packages/cli`'s bundle, which holds the code of all three and nothing else.

```bash
pnpm install
pnpm build
pnpm test
```

## Changes

This repo is a copy, written by each release: changes made here are replaced by the next one.
For a bug or an idea, use `briq feedback bug "…"` or write to
[hello@briq.cloud](mailto:hello@briq.cloud).
