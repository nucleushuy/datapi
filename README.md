# Data Pi

**A local-first data-science workbench built around [Pi](https://pi.dev).**

Data Pi brings dataset exploration, profiling, visualization, reproducible transformations, and AI-assisted discussion into one browser workspace. Inspect your data in the center, navigate projects on the left, and keep a persistent Pi conversation on the right.

The goal is a keyboard-first workbench for data scientists—not a generic dashboard or an unrestricted coding agent. Dataset versions, columns, charts, evidence, and transformation records are explicit, inspectable objects.

> **Status:** working local development application, Windows x64 first. Dataset tools, streaming Pi chat, and user-reviewed rename and chart proposals are implemented. Arbitrary code execution, model training, and multi-user hosting are not implemented.

## What works today

| Area | Capabilities |
| --- | --- |
| Import | UTF-8 CSV and Parquet, streamed uploads, progress/cancellation, immutable originals, project-scoped duplicate detection |
| Explore | Paginated original-value previews, searchable columns, schema and version provenance |
| Profile | Deterministic statistics, missingness, numeric relationships, and evidence-linked data-quality findings with sampling disclosures |
| Visualize | Histogram, box plot, bar, line, scatter, heatmap, correlation, and missingness charts; linked data/chart and chart/chart comparisons |
| Save and export | Version-bound chart configurations; PNG, SVG, HTML, JSON, and inspectable Python plotting code |
| Transform | Fixed validated operations, full-dataset impact previews, inspectable DuckDB SQL, separate approval, immutable output versions, undo/redo |
| Discuss | Right-side Pi chat, incremental replies, persistent sessions and follow-ups, cancellation, provider/model selection |
| Propose a rename | Pi proposes one disclosed column rename; local preview, exact-preview approval or rejection, persistent audit and output version |
| Propose a chart | Pi proposes a typed chart with frozen evidence; local rendered preview, inspectable JSON/Python, separate save or reject, persistent audit |
| Attach context | Dataset/profile/column/filter/chart metadata, explicitly approved text files, and selected safe metadata from prior transformation results |
| Navigate | Resizable panels, command palette, keyboard navigation, themes, and responsive layouts |

Transformations include rename/cast/drop, row filters, missing-value handling, deduplication, category mapping, datetime extraction, scaling, encoding, and derived columns from validated expressions. They are application-defined operations, not arbitrary SQL or model-generated code execution.

## Quick start

Requirements:

- **Windows 10 or later, x64.** Analytical workers fail closed on unsupported platforms.
- **Node.js 22.19.0 or newer** and npm. Check `node --version` before starting; older Node 22 versions cannot run this repository's TypeScript directly.
- A modern browser. A provider API key is optional for local data tools and required for hosted AI chat.

From the repository root:

```bash
npm install --ignore-scripts
npm run dev:workbench
```

Open **http://127.0.0.1:4310**.

To use a different port or storage directory:

```bash
npm run dev:workbench -- --port 4311 --data-dir ./local-workbench-data
```

If the offline provider model catalog is missing, hydrate it explicitly:

```bash
npm run hydrate:model-data
```

Catalog hydration downloads model metadata, not datasets. A full monorepo build is not required to start the workbench.

### First workflow

1. Create a project and import a CSV or Parquet file.
2. Inspect the preview and run a profile. Review sampling and approximation notices.
3. Open **Visualize** to configure, render, compare, and save charts.
4. Open **Data → Transform** to preview a fixed operation. Inspect its SQL and impact, approve that exact preview, then apply it.
5. Open **Chat → Connect a provider**, enter a literal API key, and select a model. Review **Context to share**, then send a question.
6. Optionally attach text files or select prior transformation results before the first message. File contents require explicit consent. Follow-ups reuse the saved context; choose **New chat** to change it.
7. Ask Pi to rename a disclosed column. In its proposal card, choose **Preview**, inspect the SQL and counts, then check approval and choose **Approve and apply**, or **Reject**. After applying, use **New chat** for the new version; **Data → Transform** provides history and undo/redo.
8. Ask Pi for a chart using disclosed fields. Choose **Preview chart**, inspect its evidence, sampling, warnings, chart specification and generated Python, then approve the exact preview and **Save chart**, or **Reject**. Saving adds a configuration to **Visualize → Saved chart configurations**; it does not change the dataset. Reload retains the decision and preview receipt, but requires a new local preview before approval.

For example, a failure-rate comparison can use time on X, a validated numeric 0/1 failure indicator on Y, mean aggregation, and machine type as a facet. Disclose these fields before starting the chat. The mean is a rate only when that binary encoding is valid; profile evidence and chart previews do not establish causation.

Use **Commands** or **Ctrl+K** for navigation and layout actions. Panel separators and tab groups support keyboard navigation. On narrow screens, the side panels stack below the workspace rather than compressing it into an unusable layout.

## Privacy and execution boundaries

**Local processing does not mean AI chat is offline.** Imports, profiles, charts, and transformations run locally. Chat sends your messages, the disclosed metadata, and any explicitly approved file contents to the selected provider. Column names, filters, statistics, and file contents can be sensitive.

- Dataset rows and cell samples are **not automatically attached** to chat. A file you choose or text you paste can still contain sensitive data; inspect it before sending.
- Text attachments support UTF-8 `.py`, `.sql`, `.txt`, `.md`, and `.json`: at most **8 files, 8 KiB each, 32 KiB total**. They are reference text and are never executed.
- Saved chat context includes exact attachment contents, UTF-8 byte lengths, and SHA-256 hashes. Reloading or following up does not silently substitute current files or a newer dataset version.
- Selected transformation results share only scoped IDs, status, version references, operation kind, timestamps, and numeric impact counts—not SQL, preview cells, or raw errors. A preview is not an applied change.
- Pi's chat tools are `propose_column_rename` and `propose_chart`. They propose operations on the frozen disclosed schema; they cannot preview, apply, approve, save, read files, run shell/Python, or execute arbitrary SQL. Their acknowledgement means awaiting local review, not an applied or saved operation.
- Manual transformations and chat rename proposals require separate, exact-preview approval. Preview SQL and counts stay local; proposal cards show no cell samples. Stale or rejected proposals cannot apply. Decisions and output versions persist across restart; original uploads remain unchanged and undo/redo switches immutable versions.
- Chart proposals validate complete specifications, declared fields and evidence references. Evidence links provide traceability, not proof; uncited proposals are labeled hypotheses with confidence capped at 50%. Local preview results, rows, generated plotting code and decisions are not returned to the provider. Save requires explicit approval of the exact current preview; expired, altered, stale and rejected previews cannot save. Chart configuration and audit publication are atomic.
- Chart exports can contain bounded dataset values and category labels. Generated Python reproduces the exported chart data; the application does not execute it.

### Credentials and local storage

The default data root is `~/.datapi/workbench`. SQLite stores application metadata; original uploads, immutable DuckDB versions, and Pi session files remain local. Chat keys use Pi credential storage at `<data-dir>/pi/auth.json` and persist across restarts. This is a local credential file, **not an encrypted secret vault**; protect the data directory and its backups.

Chat accepts explicit literal API keys for Anthropic, OpenAI, Google, Mistral, xAI, Groq, OpenRouter, and Cerebras. It does not automatically reuse the Pi CLI login, load environment-key templates, execute credential commands, or provide an OAuth login. A configured key is not proof of provider authorization or model entitlement.

The server binds to loopback and checks local request authority, origin, and a per-launch token. It is a single-user local application, not a service to expose publicly. Worker process separation and resource limits are **not a filesystem/network sandbox**.

## Reproducibility and limits

- Imports: up to **100,000,000 bytes**, 512 columns, 1 MiB serialized records, and 256 MiB decoded output. Additional Parquet footer/row-group limits can reject valid highly compressed files.
- Previews: at most **500 rows and 8 MiB** per response; wide records can produce shorter pages.
- Profiles and charts: bounded deterministic samples, up to **4,096 rows, 200,000 cells, and 16 MiB**, with feature-specific mark/column limits. Sampled counts are not population estimates; numeric arithmetic can be approximate.
- Transformations: full-dataset computation with exact row/schema/NULL impact and at most 20 illustrative input/output preview rows—not an aligned row-by-row diff. Previews expire after ten minutes; applied versions and their operation records persist.
- Analytical workers: a **five-minute deadline** and **1 GiB Windows JobObject committed-memory limit**, plus DuckDB buffer/spill and artifact limits. These are resource bounds, not permission isolation for untrusted code.
- Chat: **96 KiB** initial system/context payload, **16 KiB** messages, bounded transcript/output, and a five-minute response deadline. Starting a chat also requires its initial request to fit the 4,000-character selection limit. Larger requests fail explicitly instead of being silently truncated.
- Rename and chart proposals share limits of **8 per successful turn** and **100 retained per conversation**, without pruning audit history. Renames share existing transformation limits. Chart preview receipts expire after **30 minutes**; saved charts use the existing 100-per-dataset limit. A busy analytical worker rejects the action explicitly; retry Preview after it finishes.

Profiles, charts, and transformations retain version identity and disclose limitations. AI explanations remain inferences; they do not replace observed evidence or validate a transformation.

## Architecture

```text
Browser workbench — TypeScript, native DOM/CSS
        |
        | local HTTP commands and streamed text events
        v
Node.js workbench host — projects, context, approvals, persistence
        |                              |
        v                              v
Bounded analytical workers        Pi SDK subprocess
DuckDB + fixed operations         streamed chat + typed proposals
        |                              |
        v                              v
Immutable dataset versions        Saved Pi session history
        \______________________________/
                  Local data root
```

The web application lives in [`packages/workbench`](packages/workbench). It reuses the repository's npm workspaces, TypeScript tooling, esbuild, and Pi SDK rather than adding a separate agent engine or frontend framework. SQLite application records and Pi conversation history have distinct roles. Each subsequent turn forks the saved SDK session into a separate snapshot, selected only when its transcript and proposals commit successfully. Failed or cancelled turns cannot alter the published history; workers are not kept alive indefinitely.

## Development and verification

Run from the repository root with a supported Node version:

```bash
node --import tsx --test --test-concurrency=2 packages/workbench/test/assistant-context.test.ts packages/workbench/test/assistant-storage.test.ts packages/workbench/test/conversation-driver.test.ts packages/workbench/test/conversation-http.test.ts packages/workbench/test/conversation-proposals.test.ts packages/workbench/test/conversation-rename-http.test.ts packages/workbench/test/conversation-chart.test.ts packages/workbench/test/conversation-chart-http.test.ts packages/workbench/test/conversation-chart-proposals.test.ts packages/workbench/test/browser/conversation.test.ts packages/workbench/test/browser/chart-studio.test.ts packages/workbench/test/browser/shell.test.ts packages/workbench/test/chart-storage.test.ts packages/workbench/test/transform-storage.test.ts packages/workbench/test/transform-server.test.ts
npm run check
```

These focused tests cover context and attachment boundaries, SDK/subprocess streaming, cancellation, failed-turn isolation, HTTP body limits, rename and chart review, stale and altered previews, transaction rollback, restart, undo, and browser behavior. They use Pi's deterministic local test provider, not paid API calls. The serial SDK subprocess suite has an eight-minute deadline. `npm run check` formats/lints, checks dependency/import/lock consistency, typechecks Node/browser code, and checks browser bundling; it does not run tests.

Latest chart-proposal validation: **146 tests passed across these 15 files**, with no failures, cancellations or skips. Final `npm run check` passed with no fixes or diagnostics. Node emits its existing experimental SQLite/MockTimers notices during tests.

Real chart browser smoke covered a faceted failure-rate line chart, frozen evidence, local rendering, explicit save, Visualize list refresh, keyboard rejection, reload/server-restart persistence, busy-worker retry, reload-without-render approval blocking, and 1440px/390px layouts. Earlier rename and attachment smoke covered exact approval, stale blocking, undo/redo, file consent, incremental text, frozen references and cancellation. Hosted-provider inference has **not** been verified by these local-provider smoke tests.

See [AGENTS.md](AGENTS.md) for development rules, [CONTRIBUTING.md](CONTRIBUTING.md) for contribution policy, and the [implementation plan](docs/data-science-workbench-plan.md) for historical stages and future direction.

## What is next

Next, verify natural-language chart selection and evidence quality with an explicitly authorized hosted-provider call. Pi can propose renames and charts; approval, preview and execution results remain local and are not automatically sent back to the provider.

Arbitrary generated-code execution requires a separately verified OS sandbox. Model training, reports, hosted identity, multi-user authorization, and deployment remain later work. The Models view does not train a model today.

## Built on Pi

Data Pi builds on the [Pi agent harness](https://pi.dev). This repository also contains the upstream libraries and CLI:

- [`packages/coding-agent`](packages/coding-agent): Pi CLI, public SDK, and session lifecycle.
- [`packages/ai`](packages/ai): model/provider APIs and streaming.
- [`packages/agent`](packages/agent): agent runtime and tool execution.
- [`packages/tui`](packages/tui): terminal UI library.
- [`packages/telemetry`](packages/telemetry): telemetry contracts and adapters.

Those packages retain their own APIs and documentation. Their capabilities do not automatically become available to the browser workbench.

## License

MIT. See [LICENSE](LICENSE).
