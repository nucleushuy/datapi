<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Local data workbench

Requires **Windows 10 or later, x64, Node.js 22.19.0 or newer**, and the root workspace dependencies. Analytical processing fails closed on other platforms. Start from the repository root:

```bash
npm install --ignore-scripts
npm run dev:workbench
```

Open `http://127.0.0.1:4310`. Optional launch settings:

```bash
npm run dev:workbench -- --port 4311 --data-dir ./local-workbench-data
```

The shell has project/dataset navigation, Data/Code/Visualize/Statistics/Models workspace tabs, and Assistant/Suggestions/Activity inspector tabs. Drag the separators or focus them and use Left/Right (Home/End for limits). Below 1100px the inspector moves below the workspace; below 700px all panels stack. Individual tables and tab bars scroll without widening the page.

Use the Commands button or Ctrl+K (Command+K on macOS) for navigation, theme, and layout actions. Tab groups support Left/Right and Home/End. Escape closes the command palette and restores focus. Panel widths, selected tabs, and theme persist in browser storage for the same server address. Reset layout restores the default shell arrangement.

Create a project with a description and default preview size, import UTF-8 CSV or Parquet up to 100,000,000 bytes, and inspect original values, native/basic column types, elementary profiles, and version provenance. Preview pages contain at most 500 rows and 8 MiB, including response metadata; wide rows produce shorter pages without skipping rows. Parquet integers/decimals remain exact text, and NULL stays distinct from an empty string. No dataset content is sent to an LLM.

Application metadata lives in SQLite under `~/.datapi/workbench`; original files and separate immutable DuckDB versions use generated paths. Imports stream to staging while hashing. Failed or cancelled imports publish no dataset; Retry import requests the original file again for a fresh upload. Duplicate hashes are identified only within the same project, without sharing dataset IDs or storage. Existing JSON-backed projects migrate on startup while retaining original files and legacy metadata; a failed migration stops startup with a safe error rather than discarding data.

Ingestion limits: 512 columns, 1 MiB serialized record, 256 MiB decoded output, 16 MiB Parquet footer, and 64 MiB declared uncompressed row group. Fixed analytical workers use a Windows JobObject with a 1 GiB committed-memory cap, a five-minute deadline, and descendant cleanup; DuckDB has a 256 MiB buffer limit and 512 MiB spill limit. Derived database files have a separate 512 MiB limit. These limits can reject valid highly compressed datasets. Encrypted Parquet, INT96, nanosecond UTC timestamps and nanosecond times are explicitly unsupported. This resource boundary is **not** a filesystem/network sandbox and never accepts user code or arbitrary SQL.

Code, Visualize, Models, and assistant views are explicitly **not connected in this stage**. They do not execute code, create charts, train models, or call an AI provider. Richer profiling and data-quality reports are a later stage.

Focused checks (from the repository root; no full build or provider tests):

```bash
node --test packages/workbench/test/browser/shell.test.ts packages/workbench/test/browser/ingestion.test.ts
node --test packages/workbench/test/profiler.test.ts packages/workbench/test/storage.test.ts packages/workbench/test/server.test.ts packages/workbench/test/legacy-migration.test.ts
node --test packages/workbench/test/format-validation.test.ts packages/workbench/test/analytical.test.ts packages/workbench/test/analytical-process.test.ts
npm run typecheck --workspace=@earendil-works/pi-workbench
npm run check
```

Tests cover shell interaction, ingestion controls, CSV/Parquet values, pagination, cancellation/retry, migration, project isolation, and real Windows worker resource/lifecycle boundaries. Real-browser verification is also required for responsive layout and the complete import workflow. `npm run check` does not run tests.

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
