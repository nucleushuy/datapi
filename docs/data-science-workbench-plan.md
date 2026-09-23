# Data-science workbench implementation plan

Status: proposed architecture; awaiting approval. This document completes Prompt 1 in `pi-data-science-workbench-prompts.md`. It does not authorize Prompt 2 or any later implementation.

## 1. Scope and current checkpoint

The product is a keyboard-first Pi workbench, not a generic dashboard: resizable project/dataset navigation on the left, data/code/visualization work in the center, and assistant/evidence/activity on the right. Side-by-side comparisons must be first-class layout state. Dataset versions, operations, charts, evidence, sessions, and runs should have explicit identities and inspectable provenance.

Confirmed earlier choices: local single-user operation, Windows first, initial CSV workload up to 100,000,000 bytes. The uploaded sequence additionally requires Parquet at Prompt 3. This plan includes CSV and Parquet at that stage; parser limits and decompressed-data limits need explicit approval before implementation.

Prompt 0's operating rules are already present in `AGENTS.md`. No duplicate instructions are necessary.

### Existing uncommitted work is provisional

Before the staged prompts were supplied, a CSV-only slice was written in `packages/workbench`, with root changes in `package.json`, `package-lock.json`, and `tsconfig.json`. It includes a local HTTP host, filesystem project metadata, fixed CSV worker, paginated previews, elementary column profiles, and a native-DOM browser interface. It does not implement the requested three-panel shell, Parquet, DuckDB, complete quality profiles, or assistant integration.

Preserve these files; do not silently delete them, commit them, or call Prompts 2–4 complete. Reconcile reusable behavior and tests in the appropriate approved stage. A future storage migration must retain original files and verify hashes; do not strand existing local data or keep two competing ingestion implementations indefinitely.

Historical verification before the stage reset:

- Node `22.23.2` is installed at `C:/Users/huy/AppData/Local/pi-node/current/node.exe`; system-default Node was `22.16.0`. Root requires `>=22.19.0`. No global runtime configuration was changed.
- Dependencies were installed with `npm install --ignore-scripts`; lock metadata refreshed with `npm install --package-lock-only --ignore-scripts`. The added external package is `csv-parse` `6.1.0`; existing esbuild `0.28.1` is reused. These installations happened before Prompt 1, not during this audit.
- The three workbench test files passed: 19 tests, zero failures. They cover backend/parser/HTTP behavior, not browser interaction or the uploaded stage requirements.
- `npm run check` formatted eight workbench TypeScript files, reported a template-literal lint advisory in `test/server.test.ts`, then failed at root TypeScript checking with model-catalog `unknown`/`never` errors. Generated provider JSON is absent. Workbench-scoped typechecking and browser bundling later in the pipeline were not reached.
- The compatible Node installation produced an engine warning for the existing Gondolin example, which requires Node `>=23.6.0`; that example was not run.
- No browser workflow, near-100 MB UI import, or visual verification was completed. No application service was started. No commit or branch change was made.

This checkpoint is not a green baseline. Resolve the lint advisory and hydrate the missing model data when code verification resumes; do not alter model APIs or suppress type errors to work around missing generated data.

## 2. Repository map

Paths in this section exist. Proposed paths are labelled separately below.

| Area | Existing implementation and reuse boundary |
| --- | --- |
| Root `package.json`, `package-lock.json` | npm workspaces: `packages/*`, `packages/session-backends/*`, and selected coding-agent examples. ESM TypeScript, `.ts` relative imports, erasable syntax, tsgo, tsx, esbuild, Biome. No established React/Vite/Next application convention. |
| `packages/ai` | Provider/model APIs, streaming, usage and model catalog. `src/index.ts` is the core export; providers/API modules are separate. Legacy global model lookup lives in `/compat`. Credentials stay on the host. |
| `packages/agent` | Agent execution, tool calls, events, queues, session trees and lower-level repositories. Root, `/node`, and `/session/testing` exports have distinct runtime roles. Not a dataset-job service. |
| `packages/coding-agent` | CLI, supported Node SDK, JSONL RPC, model runtime, custom tools, resource loading, JSONL/in-memory `SessionManager`, extensions, static HTML transcript export. Primary assistant integration point. |
| `packages/tui` | Terminal rendering, editors, keybinding/autocomplete, layout/scrolling and overlays. These are not DOM components; reuse interaction principles, not terminal renderers. |
| `packages/client`, `packages/protocol`, `packages/server` | Transport-neutral remote sessions, framed CBOR schemas, experimental server orchestration. Unix transport exists. Browser network transport and production coding-agent service adapter remain application work. No ready standalone web server. |
| `packages/coding-agent/src/client` | Public `@earendil-works/pi-coding-agent/client` exports `RemoteSession` and transcript projection. Useful if the experimental remote stack is deliberately adopted; not needed for initial ingestion. |
| `packages/session-backends/sqlite-node` | Real `node:sqlite` backend for agent-core session repositories, migrations, writer leases and optional FTS search. Not an application project/dataset database and not a drop-in SDK `SessionManager`. |
| `packages/telemetry`, `packages/evals` | Existing telemetry contracts and evaluation workspace. Do not build a second agent telemetry system or run paid-provider evaluations for workbench tests. |
| `packages/workbench` | Provisional private local CSV application described above; no accepted architecture implied by its existence. |

Existing browser artifacts include `packages/coding-agent/src/core/export-html` and `scripts/tool-stats.ts`. A static transcript export or tool-usage chart report is not a live workbench or reusable data-charting engine.

## 3. Agent launch and integration choices

### Recommended: public Node SDK behind an application adapter

`packages/coding-agent/src/index.ts` exports the supported SDK. `createAgentSession` in `src/core/sdk.ts` accepts `modelRuntime`, `model`, `sessionManager`, `settingsManager`, `resourceLoader`, `customTools`, and explicit tool selection. It returns an `AgentSession` plus extension-loading results.

Public session operations include `subscribe`, `prompt`, `abort`, `waitForIdle`, and `dispose`. Use settled/idle semantics for turn completion rather than assuming every `agent_end` means all work finished. `defineTool` plus TypeBox parameters provides typed custom tools with cancellation, progress updates, and structured result details.

Recommended service configuration:

- Explicit allowlist containing only application-owned tools; do not inherit read/bash/edit/write defaults.
- Controlled resource loader and settings. No ambient project/user extensions, skills, configuration shell commands, or arbitrary context-file loading from uploaded data.
- Application-owned mapping from project/session IDs to a dedicated `SessionManager` directory. Never accept filesystem session paths from the browser.
- `ModelRuntime` owns provider credentials/configuration. Browser model selection uses validated IDs, not executable configuration or credential values.
- Only deliberately constructed schema/statistics/evidence context goes to a provider. Original rows are excluded by default; even column names and statistics can be sensitive.
- Custom tools resolve authorized opaque dataset-version IDs and call application workers. They never accept unrestricted host paths or relay arbitrary shell commands.

`SessionManager.create`, `open`, `continueRecent`, `list`, and `inMemory` are supported. Resume through these factories, not an invented `continueSession` SDK option. Lower-level `SessionRepo`/SQLite objects are different APIs.

### Alternatives and why they are not the default

| Boundary | Benefits | Costs and decision |
| --- | --- | --- |
| Direct SDK | Supported TypeScript API; existing lifecycle, custom tools and session persistence; fewer translation layers. | Runs host-side with host permissions. Choose this behind a narrow application adapter, not in browser components. |
| JSONL RPC subprocess | Supported `pi --mode rpc`; process separation and language-independent host integration. | A subprocess is not a sandbox. Raw RPC includes shell and filesystem-path commands; never expose it directly to a browser. Prefer only if process ownership requirements justify the adapter. |
| `RemoteSession` → `PiClient` → CBOR → `PiServer` | Existing snapshots, progress projection, leases, reconnect and conformance tests. | Explicitly experimental; missing browser transport and production SDK/service adapter. Adopting it now adds work unrelated to Prompt 2–3. Revisit at assistant integration if its reuse outweighs compatibility and adapter costs. |

JSONL RPC and framed CBOR are different protocols. A command response may mean accepted/queued, not completed. Local exclusive client leases are not user authorization.

## 4. Proposed architecture and data flow

All decisions in this section require approval. Do not install these future dependencies during Prompt 1.

```text
Browser: three-panel shell and bounded view models
       |
       | same-origin HTTP commands, paginated results, bounded progress/events
       v
Workbench Node host
  - local access policy; later authenticated principal and ownership checks
  - project/dataset/artifact/session orchestration
  - versioned request/result schemas and explicit approval state
  - metadata transactions and job lifecycle
       |                         |
       v                         v
Analytical worker process       Pi SDK adapter (Prompt 6)
  - DuckDB                      - controlled tools/resources
  - fixed validated operations  - schema/statistics context
  - bounded output and deadline - provider credentials host-side
       |                         - bounded event/result projection
       v
Immutable source files + derived versions + artifacts
       |
Application metadata database (separate from Pi conversation history)

Later: isolated Python execution workers, never in the web server process
```

### Browser and build system

Recommendation: retain TypeScript, native DOM/CSS and esbuild for the initial shell, split into small feature modules rather than grow the provisional global `app.ts`. No existing reusable frontend framework was found. This avoids a new build system and large runtime dependency for the first layout milestone.

The tradeoff is manual lifecycle/state management as the UI grows. React is a reasonable alternative if the user prefers a component ecosystem; it is not an existing repository convention. Select it deliberately before Prompt 2, not midway through that stage. Code editing and chart libraries should be selected at their own stages based on actual requirements, not guessed now.

Prompt 2 acceptance must include keyboard-resizable splitters, persisted panel widths and tabs, an accessible command palette, light/dark tokens, error recovery, loading/empty states, and desktop/tablet behavior. On smaller widths, switch panels without forcing horizontal page overflow. Center content needs a split-view layout model so later comparison is not a separate application. Mock view models, when the shell prompt permits them, must be visibly labelled and never masquerade as backend results.

### Application data and analytical engine

Recommend application-owned SQLite metadata with explicit migrations, plus opaque-ID local file storage. Keep this database separate from Pi session storage. Use immutable input/version references, content hashes, operation specifications and provenance links; do not overload agent history with datasets or large tool results.

SQLite is for metadata transactions, not analytical queries. Native `node:sqlite` already has a repository precedent, but synchronous calls should be short or worker-owned. Schema design is new work, not a claim that project/dataset/job tables already exist. A future hosted database migration is possible through a narrow repository boundary; avoid a generic database abstraction framework.

Recommend DuckDB through its official Node Neo client for CSV/Parquet previews, profiling and later fixed transformations. Official documentation lists Windows x64 support. Validate pinned package installation without lifecycle scripts, native binary behavior, memory/spill limits, interruption, precision and CSV type handling before adopting it. Documentation is evidence of support, not a runtime test on this machine.

Use one analytical path, not permanent independent `csv-parse` and DuckDB result engines. The provisional parser/tests are migration input. Preserve raw strings and parsing decisions when defining CSV type inference; make Parquet/native numeric/date conversion explicit. Preview and aggregate queries are application-generated from validated specifications. No unrestricted user SQL or extension loading in the initial worker.

### Jobs, resources and persistence

Application owns ingestion/profiling/analysis jobs; Pi's steer/follow-up queues are not a replacement. Start with one active analytical job, bounded pending work, and persisted lifecycle transitions: queued/running/completed/failed/cancelled. Worker communication carries IDs and bounded messages, not whole input files.

Upload to staging while hashing and enforcing the byte limit. Parse into staged derived artifacts. Atomically publish only successful results. Cancellation must terminate computation and clean staging without publishing a partial dataset. Restart distinguishes completed artifacts from abandoned work and leaves the immutable source verifiable. A changed source hash invalidates a cached profile; never silently attach a profile to different bytes.

Limit input size, columns, record/cell sizes, decompressed output, result rows/bytes, process lifetime, concurrency and temporary disk usage. Do not equate a JavaScript heap limit with a native-memory cap. Worker processes improve failure separation but are not OS authorization boundaries. Native parser/container resource enforcement requires verification at the ingestion stage.

Generated Python/shell is out of scope until the isolated-execution stage. It requires fail-closed OS isolation with CPU/memory/time/disk/network controls, minimal mounts, a sanitized environment and validated outputs. On Windows, evaluate a Linux-container/WSL2 runtime then; do not make the initial shell depend on it or silently fall back to host execution.

## 5. Package/module layout

Keep one private workbench workspace initially. No changes to Pi core public APIs are proposed. Existing workbench files can be reorganized only in approved implementation stages.

Existing paths:

```text
packages/workbench/package.json
packages/workbench/tsconfig.json
packages/workbench/src/contracts.ts
packages/workbench/src/cli.ts
packages/workbench/src/server.ts
packages/workbench/src/storage.ts
packages/workbench/src/profiler.ts
packages/workbench/src/csv-worker.ts
packages/workbench/src/browser/{app.ts,index.html,style.css}
packages/workbench/test/{server,storage,profiler}.test.ts
```

Proposed future modules, not existing APIs or files:

```text
packages/workbench/src/browser/shell/       panel layout, tabs, palette, view state
packages/workbench/src/browser/features/    datasets, profiles, charts, assistant
packages/workbench/src/domain/              versioned application schemas and operations
packages/workbench/src/persistence/         application metadata/files and migrations
packages/workbench/src/jobs/                durable lifecycle and worker supervision
packages/workbench/src/workers/             fixed analytical process entrypoints
packages/workbench/src/pi/                  public-SDK adapter and context construction
```

Create modules only as the corresponding stage needs them. Do not pre-create empty services, fake APIs, framework layers or all future folders. Introduce a separate execution package only when an actual process/runtime/deployment boundary requires it.

Expected Prompt 1 change: this document only. Future root wiring stays limited to workspace launch/check integration and reviewed lockfile changes; npm already discovers `packages/*`.

## 6. Confirmed decisions versus open validation

| Status | Decision or prerequisite |
| --- | --- |
| Confirmed by user | Local, single-user, browser application first; Windows target; initial CSV up to 100 MB. |
| Confirmed by uploaded instructions | Sequential stages with stop points; three-panel resizable interface; side-by-side comparisons; CSV and Parquet at ingestion; no product changes during Prompt 1. |
| Confirmed from source | npm/TypeScript/esbuild/Biome setup; supported Node SDK and JSONL RPC; experimental remote stack; real agent persistence; no ready multi-user web auth or analytical job service. |
| Proposed for approval | One workbench workspace; native DOM/CSS + esbuild shell; direct public SDK host integration; SQLite application metadata; DuckDB analytical process. |
| Needs validation at its stage | DuckDB native installation, cancellation and actual process memory/disk limits on Windows; Parquet decompression bounds; treatment of precision/dates/nested types. |
| Needs validation before agent use | SDK resource loading isolation, exact allowed tools, server-only secret handling, approved compact context and safe streaming/reconnect behavior. |
| Needs validation before generated code | Available Windows-compatible OS sandbox/runtime and fail-closed execution proof. Neither worker_threads nor subprocess RPC is enough. |
| Deferred, not omitted | Hosted identity provider, deployment platform, shared database/blob storage, quotas, billing if ever needed. Decide at multi-user/deployment stages, not now. |

## 7. Milestones and stage gates

Only Prompt 1 is being executed. The table is sequencing, not permission to implement the later prompts. Read each full prompt immediately before its stage and update this plan if findings require an approved change.

| Stage | Bounded deliverable and exit gate |
| --- | --- |
| 0 | Existing persistent project instructions reconciled; no duplicate rule file. |
| 1, current | Source-grounded plan, decisions and risks; stop for architecture approval. |
| 2 | Three resizable panels, requested center/right tabs, palette, themes, persistent layout and accessibility. Clearly labelled shell-only view models where needed. Browser proof and component behavior tests; no ingestion expansion. |
| 3 | Project/dataset entities, CSV and Parquet streaming ingestion, immutable sources, hashes, bounded analytical previews, progress/cancel/retry, safe failures and project scoping. Reconcile provisional storage rather than declare it sufficient. |
| 4 | Deterministic versioned profiles and quality evidence, richer statistics/semantic candidates, exact-vs-approximate labels, cache keys and cancellation. Provisional min/max/counts are not the complete stage. |
| 5 | Deterministic visualization studio and side-by-side comparison; serializable chart specifications, safe aggregation and export. Select chart library here. |
| 6 | Pi read-only assistant and evidence-based proposals through the approved boundary, explicit context-sharing preview and validation. No arbitrary transformation execution. |
| 7 | Validated reproducible transformations, impact preview, approval, immutable versions and undo/redo. |
| 8 | Code workspace with independently verified OS-isolated execution; no host fallback. |
| 9 | Guided modeling with explicit experiment/run specifications. Read full stage requirements before implementation. |
| 10 | Reports and project history, reproducible artifact references and export. |
| 11 | Separate approved multi-user migration: authentication, authorization and quotas. |
| 12–14 | Production threat/failure review, deployment design, then final product audit. Separate prompts and acceptance checks. |

Local MVP checkpoint: stages 2–6 make a useful inspect/profile/compare/ask workflow without arbitrary code. Stages 7–10 extend the local product; they are not silently dropped. Each stage has its own plan, exact expected files, tests and approval/stop gate.

### Later multi-user migration

Document the local trust model before exposing any remote listener. Introduce authenticated principals and enforce membership/ownership for every project, dataset version, job, artifact, event stream and Pi session. A UUID or content hash is not authorization.

Plan migrations for metadata, explicit ownership of existing local data, provider credential policy, per-user quotas, worker scheduling, temporary-disk limits, durable job recovery and audit records. Hash deduplication must not cross authorization boundaries. Remote access also needs TLS, browser-session/CSRF policy, secret management and backups. Select database/object storage based on deployment needs then; do not bolt multiple users onto the local per-launch token.

## 8. Security and privacy findings

- **Pi defaults trust the host environment.** SDK defaults include powerful tools. `cwd` is not a filesystem jail: absolute and home-relative paths are supported. Disable ambient discovery and allow only application tools.
- **Raw RPC is not a web API.** Its direct `bash`, session-switch and export commands can reach the filesystem independently of model-facing tool allowlists. Validate a narrow host contract instead of proxying arbitrary commands.
- **Provider auth is not user auth.** `src/core/auth-storage.ts` stores provider keys/OAuth; it does not identify browser users. Requested Unix modes do not establish Windows ACL protection or encryption.
- **Examples do not establish a sandbox.** `examples/extensions/sandbox/index.ts` is Bash-only, is unsupported on Windows, can be disabled by project settings and falls back to local Bash on initialization failure. Gondolin routes selected tools but not optional PowerShell; its environment filter retains all string values, while the shell environment includes `process.env`. Do not forward secrets or accept these examples unchanged as a boundary.
- **Local browser attacks remain relevant.** Bind loopback; validate Host/Origin/fetch metadata and per-launch authorization; no wildcard CORS. Treat later remote exposure as a different architecture, not a flag.
- **Untrusted data is not instructions.** Render values as text; validate schemas; keep names/paths separate; reject traversal and oversized/invalid formats. Model-supplied specifications require validation and cannot widen filesystem or network authority.
- **Privacy includes metadata.** Column names, profiles, categories and small aggregates can disclose sensitive data. Show outbound context, redact as needed, prohibit row sharing by default and exclude raw cells/credentials from logs, traces and conversation history.
- **Resource limits must cover native work.** Input limits alone do not prevent Parquet expansion, expensive queries, disk exhaustion or huge result sets. Enforce row/byte/time/memory/disk/concurrency limits and cancellation at the worker boundary.
- **Reproducibility is an invariant.** Preserve source/version hashes, parser/profile versions, structured operations and artifact lineage. Cache and publish results only for the matching immutable version.

Source anchors: `packages/coding-agent/docs/{sdk,rpc,containerization,windows}.md`; `src/core/{sdk,resource-loader,settings-manager,auth-storage,resolve-config-value}.ts`; `src/core/tools/{path-utils,bash}.ts`; `src/utils/shell.ts`; sandbox/Gondolin example implementations; `packages/server/src/{types,listener,connection}.ts`.

## 9. Testing and proof strategy

- Prompt 1: source-backed audit and this document; no installs, scaffolding, feature edits or additional validation runs after the stage reset.
- Shell: component behavior for splitter persistence, tabs, command palette, focus and keyboard navigation; actual browser screenshots/interaction at desktop and tablet widths, error/loading/empty states and no page overflow. Select a DOM/browser test dependency explicitly at Prompt 2 if needed; no such frontend test stack is currently established.
- Ingestion: fixture-based CSV/Parquet correctness, adversarial filenames/content, strict limits, bounded output, cancellation during upload/parse/publish, retry, restart and no cross-project lookup. Browser-drive the complete create/import/inspect/restart flow; include a near-limit file and observe memory/disk behavior.
- Profiles/charts: known numerical fixtures, exact/approximate flags, deterministic cache invalidation, operation/spec round-trips, provenance and bounded exports. Test returned behavior, not source text or implementation details.
- Assistant: reuse existing SDK/faux-provider conventions, no real paid tokens. Test safe context construction, malicious names/cells, structured-output rejection, unsupported claims, session isolation and cancellation. Existing remote-session/projector tests are reusable if that stack is selected.
- Execution: adversarial filesystem/network/environment tests inside the actual target sandbox, hard resource/deadline termination, no fallback and output validation before enabling the feature.
- After each approved code stage: narrow relevant tests, actual surface smoke, then `npm run check` with full output. Do not run root `npm test`, full Vitest, or builds without the repository's required authorization. Preserve unrelated work if formatters encounter it.

## 10. Verified development commands

Commands below are verified from manifests/scripts, not all executed. Run from the repository root unless a package directory is shown. Use Node >=22.19.0; the Gondolin example has a higher requirement and is not needed for these stages.

| Command | Meaning and caveat |
| --- | --- |
| `npm install --ignore-scripts` | Hydrate workspace dependencies without lifecycle scripts. Executed before Prompt 1. |
| `npm install --package-lock-only --ignore-scripts` | Refresh lockfile after reviewed dependency metadata changes. Executed before Prompt 1. |
| `npm run check` | Biome **writes formatting/fixes**, then dependency/import/lock checks, root tsgo, provisional workbench typecheck and browser bundling. Historical failure described above; not a test suite. |
| `npm run hydrate:model-data` | Root delegates to AI strict data-only catalog hydration. Network access required; writes ignored provider JSON, not a reason to edit `models.generated.ts`. Source-supported repair for missing data; not run during Prompt 1. |
| `npm run check:model-data` | Validates hydrated model data. Does not replace narrow product tests. |
| `npm run check:browser-smoke` | esbuild browser compatibility/tree-shaking check, **not** a UI browser test. |
| `npm run dev:workbench` | Provisional launcher: `node packages/workbench/src/cli.ts`; defaults to loopback port 4310 and `~/.datapi/workbench`. Not browser-verified. |
| `npm run dev:workbench -- --port 4310 --data-dir <directory>` | Provisional launcher with explicit data root. Placeholder must be replaced by a real path. |
| `npm run typecheck --workspace=@earendil-works/pi-workbench` | Provisional scoped tsgo check, includes DOM types. Not reached by the failed root check. |
| `node --test test/profiler.test.ts test/storage.test.ts test/server.test.ts` from `packages/workbench` | Executed with the compatible Node binary: 19 passed. |
| `node ../../node_modules/vitest/dist/cli.js --run test/client/remote-session.test.ts` from `packages/coding-agent` | Existing focused public-client contract test; command/path verified, not run in this audit. |
| `node --test test/specific.test.ts` from `packages/tui` | Repository pattern; replace `specific.test.ts` with a verified target. |
| `./test.sh` | Root Bash wrapper that isolates environment/config and invokes non-provider-dependent tests. Requires Bash on Windows; arguments are not a file filter. Not run. |
| `.\pi-test.ps1` / `.\pi-test.ps1 --mode rpc --no-session` | Existing Windows source launch via tsx. Provider/model/generated-data prerequisites still apply. Not run. Avoid `--no-env` for a clean RPC stream: it prints a banner and is not complete credential isolation. |
| `pi --mode rpc --no-session` | Installed/built CLI JSONL RPC launch, not the experimental CBOR protocol. Requires actual CLI installation. |
| `npm run dev --workspace=@earendil-works/pi-server` | TypeScript watch only; does **not** launch an application server. |
| `npm run build` / `npm run build:offline` | Existing ordered package builds. Offline requires hydrated data; neither is authorized or run by this documentation stage. |

There is no generic root `dev` web-server command beyond the provisional workbench launcher. Full SDK package-root runtime imports normally resolve built `dist` exports; do not claim direct SDK execution is ready merely because source aliases typecheck. Establish the supported source/build workflow when assistant integration is approved.

Official analytical-client evidence: [DuckDB Node Neo overview](https://duckdb.org/docs/current/clients/node_neo/overview.html) documents the high-level `@duckdb/node-api` package and Windows x64 support. Dependency version, lifecycle behavior and runtime limits still need stage-specific verification.

## 11. Approval gate

Approve or amend these choices before Prompt 2:

1. One private `packages/workbench` application; no Pi core/public-API changes.
2. Native TypeScript DOM/CSS + esbuild for the three-panel shell, or explicitly choose a frontend framework now.
3. Public Node SDK host adapter for later assistant integration, with custom-tool allowlist and controlled resources; no raw browser RPC.
4. SQLite application metadata plus immutable local files; DuckDB analytical worker for CSV and Parquet at Prompt 3.
5. Fixed operations first; generated Python/shell only after a verified fail-closed OS sandbox.

Preserve the provisional implementation while its parts are reconciled stage by stage. Do not automatically create branches or commit existing work to satisfy the uploaded workflow suggestion; the worktree contains prior uncommitted changes and the user's prompt file. Agree on the checkpoint/branch action before doing either.

Stop here. Next task, only after approval: read Prompt 2 in full and present its exact file scope and acceptance criteria before changing code.
