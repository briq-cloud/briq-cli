# @briq-cloud/cli

The command line for [briq](https://briq.cloud). Run Postgres, Redis or any Docker image on a cloud
microVM. Fork a whole stack, data included, for each git branch.

```bash
npm install -g @briq-cloud/cli
briq login
briq run postgres --sleep 2h
```

`briq run` prints the connection string (`DATABASE_URL=postgres://…`). The database sleeps after
two hours without use and wakes on the next call, with its data.

Needs Node 22.6 or later.

## A database per git branch

Declare the stack in `briq.yaml`, at the root of the repo:

```yaml
stack: shop
services:
  db: { recipe: postgres }
  cache: { recipe: redis }
```

Then:

```bash
briq up --env .env
briq fork --stack shop --branch feat/login --env .env.local --expose
briq destroy --branch feat/login
```

1. `briq up` creates the services the stack does not have, and writes their connection strings
   to `.env`.
2. `briq fork` copies every service of `shop`, disks included, into the stack `feat-login`.
   `--expose` gives each database a TLS endpoint, so this machine reaches the copy through
   `.env.local`.
3. `briq destroy --branch` removes the copy once the branch is merged.

To run it from git hooks: [A database per branch](https://briq.cloud/docs/guides/database-per-branch).

## Sign in

| Command | When |
| --- | --- |
| `briq login` | On your machine. Open the link it prints, pick the team and the budget, approve. |
| `cat key.txt \| briq login --key` | With an API key from the dashboard's Agents page. |
| `export BRIQ_API_KEY=bq_live_…` | In CI, a container or an agent. It wins over a saved sign-in. |

`briq whoami` shows the team, the credential and its budget. `briq logout` forgets the sign-in on
this machine. Revoke it on the dashboard's Agents page.

## Commands

| Command | What it does |
| --- | --- |
| `briq catalog [name]` | List the recipes, or show one with its fields and outputs |
| `briq run <recipe or image>` | Create and start a briq |
| `briq up` | Create what the stack in `briq.yaml` does not have |
| `briq list` | List the briqs of the team |
| `briq status <briq>` | Show one briq |
| `briq logs <briq>` | Show its recent logs |
| `briq exec <briq> <cmd…>` | Run a command in it, and exit with its code. `--async` for a long one |
| `briq files-put <briq> <path> [file]` | Upload a file, 1 MB at most |
| `briq files-get <briq> <path>` | Download a file |
| `briq expose <briq> <port>` | Give a port a URL. `--protocol postgres` for a TCP endpoint over TLS |
| `briq fork [briq]` | Fork a briq, or every briq of a stack with `--stack` |
| `briq stop <briq>` | Stop it. Its disk is kept |
| `briq start <briq>` | Start it again |
| `briq destroy [briq]` | Destroy a briq, or a whole stack with `--stack` or `--branch` |
| `briq set-sleep <briq> <sleep>` | Set when it sleeps: `30m`, `3h`, `7d` or `never` |
| `briq quota` | Show what the credential may still spend and run today |
| `briq feedback <topic> <message>` | Write to the briq team: `bug`, `idea` or `question` |

A `<briq>` is an id, such as `bq_7kq2m9x1p4ab`. `--json` on any command prints the API's response.
Each command is an [MCP tool](https://briq.cloud/docs/mcp/tools) with the same options: `briq exec`
is `briq_exec`. Every option is in the [CLI reference](https://briq.cloud/docs/cli).

## Scripts and CI

| Variable | What it sets | Default |
| --- | --- | --- |
| `BRIQ_API_KEY` | The API key every call uses | The saved sign-in |
| `BRIQ_API_URL` | The API to call | `https://api.briq.cloud` |
| `BRIQ_CONFIG_DIR` | Where the sign-in is saved | `~/.config/briq` |

| Exit code | Meaning |
| --- | --- |
| `0` | Done |
| `1` | The API refused the call, or could not be reached |
| `2` | A wrong command, flag or argument |
| `3` | Not signed in, or the credential was refused |

`briq exec` and `briq exec-result` exit with the command's own code.

## Links

- [Docs](https://briq.cloud/docs) · [CLI reference](https://briq.cloud/docs/cli) · [Stack file](https://briq.cloud/docs/stack-file)
- Help: [hello@briq.cloud](mailto:hello@briq.cloud)
- Licence: MIT
