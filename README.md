# AI Office

A gated workflow layer for multi-vendor AI coding agents (Claude Code and
Codex), from discussion to pull request, with a pixel-art virtual office as the
main UI.

You describe a requirement. AI Office runs a meeting between agents, turns the
agreed conclusion into work items, has agents implement them in their own
worktrees and branches, merges their PRs into an integration branch, and opens
one final PR for you. Agents run inside Orca, a multi-agent IDE;
GitHub holds the issues and PRs; every decision stays with you, in AI Office.

## Status

**v0.1, early.** AI Office is a personal open-source project. It runs locally
on macOS, for one user, against repositories you own. Expect rough edges.

The full flow, from meeting to final PR, has been run end to end against real
Orca, GitHub, Claude Code and Codex at the scale of a small feature with
several work items. Known problems from those runs and their fixes are in
[Troubleshooting](guide/troubleshooting.md).

The current release is `v0.1.0`. AI Office is installed from source: clone the
repository, check out the tag (`git checkout v0.1.0`) and build it
([Install](guide/install.md)). `ai-office --version` prints the version and the
commit you run.

## Try it in five minutes (fake mode)

Fake mode simulates Orca, GitHub and the agents, so it needs no accounts, no
tokens and no Orca. It never touches your real data directory.

```sh
pnpm install
pnpm build
pnpm dev:office --fake demo --open
```

A browser opens AI Office with a simulated repository already registered.
Choose **New workflow**, pick the `demo` template and enter any requirement.
Simulated agents meet, split the work and implement it while you decide the
gates; the simulated final PR merges by itself a few seconds after its gate
opens. Press Ctrl-C to stop. See [Usage](guide/usage.md#fake-mode) for the other scenarios.

## Quick start (production)

Production mode drives your real Orca, real GitHub account and real agents.
Read [Prerequisites](guide/prerequisites.md) and [Safety](guide/safety.md)
first.

```sh
pnpm install --frozen-lockfile
pnpm build
alias ai-office="node $PWD/apps/cli/dist/main.js"
ai-office start
```

`ai-office start` starts the backend on `http://127.0.0.1:4319` (the port is
configurable) and opens a one-time login link in your browser. In the UI, register a repository, then start a
workflow from the built-in `feature-to-pr` template. See
[Usage](guide/usage.md).

## Documentation

| Guide                                       | What it covers                                             |
| ------------------------------------------- | ---------------------------------------------------------- |
| [Install](guide/install.md)                 | Building from source and the `ai-office` command           |
| [Prerequisites](guide/prerequisites.md)     | Orca, agents, `gh`, GitHub account and repository settings |
| [Configuration](guide/configuration.md)     | `config.toml`, `AI_OFFICE_HOME`, templates                 |
| [Usage](guide/usage.md)                     | Starting, gates, merging, cleanup, cancel, replay          |
| [Safety](guide/safety.md)                   | What agents can and cannot do, residual risks, data        |
| [Troubleshooting](guide/troubleshooting.md) | Startup refusals and runtime problems                      |
| [Development](guide/development.md)         | Contributing, checks, tests, fixtures                      |
| [Dogfooding](guide/dogfooding.md)           | Developing AI Office with AI Office, after v0.1            |

After v0.1, AI Office is developed with AI Office itself; see the
[dogfooding plan](guide/dogfooding.md).

## Acknowledgements

- The office scene uses only the
  [Endesga 32](https://lospec.com/palette-list/endesga-32) palette by Endesga.
- All characters, props and effects are drawn for this project.
- The bundled ASCII pixel font (`AI Office Pixel`) is a subset of
  [DotGothic16](https://github.com/fontworks-fonts/DotGothic16) by the
  DotGothic16 Project Authors, under the SIL Open Font License 1.1; see
  `apps/web/src/shared/fonts/`.

## License

AI Office is released under the [MIT License](LICENSE). The bundled font keeps
its own license (SIL Open Font License 1.1).
