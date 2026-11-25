# Install

AI Office is installed from source. There is no npm package or binary release.

## Requirements

- macOS. Production mode depends on Orca, which AI Office drives on macOS.
  Fake mode (see [Usage](usage.md#fake-mode)) needs only Node.js and pnpm.
- Node.js 24. The repository pins 24 in `.nvmrc` and `.node-version`. Homebrew's
  default `node` may be newer and broken; install `node@24` instead
  ([Troubleshooting](troubleshooting.md#wrong-nodejs-version)).
- pnpm 10.34.9, the version pinned in `packageManager`. If you do not have it:

  ```sh
  npm install --global pnpm@10.34.9
  ```

For production mode you also need Orca, the agent CLIs and `gh`; see
[Prerequisites](prerequisites.md).

## Build

```sh
git clone https://github.com/ClarkeYeh/ai-office
cd ai-office
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` builds every workspace, including the web UI
(`apps/web/dist`), which the backend serves itself in production.

## The `ai-office` command

The CLI entry point is `apps/cli/dist/main.js`. Run it with Node from the
checkout:

```sh
node apps/cli/dist/main.js --help
```

The simplest way to get an `ai-office` command is a shell alias, defined from
the repository root (add it to your shell profile with the absolute path):

```sh
alias ai-office="node $PWD/apps/cli/dist/main.js"
ai-office --help
```

The CLI locates the backend relative to its own file
(`apps/server/dist/main.js`), so keep using it from inside the built checkout.
Do not copy `main.js` elsewhere.

Commands:

| Command            | Who uses it | Purpose                                                                     |
| ------------------ | ----------- | --------------------------------------------------------------------------- |
| `ai-office start`  | you         | Start the backend and open the UI ([Usage](usage.md#start-and-stop))        |
| `ai-office open`   | you         | Get a new login link for a running backend ([Usage](usage.md#log-in-again)) |
| `ai-office submit` | agents      | Structured submissions from agents to the backend; not for humans           |

To see which version you run, use `git log -1 --oneline` in the checkout.

## Update

```sh
git pull
pnpm install --frozen-lockfile
pnpm build
```

Stop the backend before rebuilding and start it again afterwards. The database
migrates itself on start and keeps a backup when it does. Built-in templates
are copied into your data directory only once; see
[Configuration](configuration.md#templates) for picking up template changes.

## Uninstall

Delete the checkout, and delete the data directory (`~/.ai-office` by default)
if you no longer want its history. The folder workspace you added to Orca for
AI Office can only be hidden in Orca, not removed
([Prerequisites](prerequisites.md#the-orca-home-folder)).
