# Data-science workbench implementation plan

Status: architecture and Prompts 2–7 approved and implemented. Shell, ingestion, profiling, visualization, read-only Pi assistant suggestions and fixed reproducible transformations are complete. Prompt 8 is on hold. Pi conversational-session research and the reuse plan below are complete; the user permitted a plan-first checkpoint before later chatbox implementation.

## 1. Scope and current checkpoint

The product is a keyboard-first Pi workbench, not a generic dashboard: resizable project/dataset navigation on the left, data/code/visualization work in the center, and assistant/evidence/activity on the right. Side-by-side comparisons must be first-class layout state. Dataset versions, operations, charts, evidence, sessions, and runs should have explicit identities and inspectable provenance.

Confirmed choices: local single-user operation, Windows x64 first, CSV and Parquet up to 100,000,000 bytes. Prompt 3 conservative limits were approved: 512 columns, 1 MiB serialized record, 256 MiB decoded output, 16 MiB Parquet footer, 64 MiB declared uncompressed row group, 1 GiB worker committed memory, five-minute processing deadline, and bounded DuckDB spill/artifacts. Preview responses are at most 500 rows and 8 MiB.

Prompt 0's operating rules are already present in `AGENTS.md`. No duplicate instructions are necessary.

### Current uncommitted implementation

The implementation is in `packages/workbench`: native-DOM shell, SQLite application metadata, project-scoped durable jobs, streamed CSV/Parquet imports, immutable originals, versioned DuckDB artifacts and bounded previews. Prompt 4 adds deterministic profiles and quality reports; Prompt 5 adds charts, comparisons and bounded exports. Prompt 6 adds explicit metadata-sharing approvals, public-SDK suggestions and locally previewed chart proposals. Prompt 7 adds fixed full-dataset transformations, exact impact previews, separate approval, immutable publication and persistent undo/redo. The assistant can propose validated operations but acceptance only opens local review; it still uses fresh independent sessions, not persistent conversation. Arbitrary transformations, model training and application Python execution remain disabled.

Changes remain uncommitted. Legacy JSON projects migrate under the existing storage lock with source-hash verification; originals and legacy metadata are retained. The former JSONL preview engine is no longer used.

Historical verification before the stage reset:

- Node `22.23.2` is installed at `C:/Users/huy/AppData/Local/pi-node/current/node.exe`; system-default Node was `22.16.0`. Root requires `>=22.19.0`. No global runtime configuration was changed.
- Dependencies were installed with `npm install --ignore-scripts`; lock metadata refreshed with `npm install --package-lock-only --ignore-scripts`. The added external package is `csv-parse` `6.1.0`; existing esbuild `0.28.1` is reused. These installations happened before Prompt 1, not during this audit.
- The three workbench test files passed: 19 tests, zero failures. They cover backend/parser/HTTP behavior, not browser interaction or the uploaded stage requirements.
- `npm run check` formatted eight workbench TypeScript files, reported a template-literal lint advisory in `test/server.test.ts`, then failed at root TypeScript checking with model-catalog `unknown`/`never` errors. Generated provider JSON is absent. Workbench-scoped typechecking and browser bundling later in the pipeline were not reached.
- The compatible Node installation produced an engine warning for the existing Gondolin example, which requires Node `>=23.6.0`; that example was not run.
- No browser workflow, near-100 MB UI import, or visual verification was completed. No application service was started. No commit or branch change was made.

This historical checkpoint was not a green baseline. Subsequent Prompt 3–5 results below supersede it. Model APIs were not weakened to bypass missing generated data.

### Prompt 3 verification checkpoint (history)

- Real browser: project description/default rows, CSV/Parquet import and schema, exact large integer/decimal text, null/empty distinction, paging, malformed input preserving the current dataset, cancellation, fresh-file retry, same-project duplicate indication, and persistence across server restart.
- Near-limit browser import: 98,688,899-byte CSV, 100,000 rows. The 50-second observation window saw server private memory at most 72,056,832 bytes and working set at most 67,878,912 bytes; this is an observed workload, not a universal bound.
- Real Windows helper tests enforce per-process and aggregate 1 GiB JobObject memory limits; verify timeout, cancellation, parent/launcher death, descendant cleanup, and environment sanitization. This is resource isolation, not a filesystem/network sandbox.
- Focused tests cover migration repair/restart, project-scoped endpoints, malformed formats/encodings, serialized-record and decoded limits, Parquet row-group limits, and short byte-capped preview pages.
- All 67 focused workbench tests passed across the documented test files; `npm run check` passed formatting/lint, pinned dependencies, import/lock checks, root/workbench types, and browser bundling. Node still emits its experimental SQLite/MockTimers notices during tests; no suppression was added.
- Parquet group metadata exposes null native types for LIST/STRUCT nodes; bounded schema binding now obtains complete column types without reading rows. Regression fixtures include lists and exact numeric values.
- No AI, generated-code execution, or Prompt 4 expansion. See the root README for current commands and supported limits.

### Prompt 4 checkpoint (history)

- Explicit cancellable rich-profile jobs, separate from ingestion recomputation; cache keys include project/dataset/version, actual artifact SHA-256, and profiler version. Cache reads and publication validate artifact identity; original datasets and lineage are unchanged.
- Overview, searchable beside-preview column inspector, complete numeric statistics and semantic candidates, severity-filtered quality evidence, redacted examples and proposed actions. All sampled quantities and numeric approximations are labeled.
- At most 4,096 sampled rows, 200,000 cells, 16 MiB sample bytes, 24 numeric correlation fields, 128 findings and 4 MiB reports. Deterministic systematic sampling may miss periodic or rare observations; limitations are displayed, not hidden.
- Wide profiling orders bounded row identifiers before projecting columns, avoiding DuckDB's wide Top-N memory expansion without raising its 256 MiB limit.
- Browser exercised full and sampled reports, column search/selection, severity filtering, cancellation/rerun, cache reuse, restart persistence, dataset switching and 390px layout. Initial preview now finishes before saved-profile lookup to avoid competing for analytical admission.
- Focused workbench tests passed after updating the intentional control-request size boundary and adding two preview/profile admission regressions; final `npm run check` passed. The fixed-worker 512-column fixture passes without relaxing memory limits. Validation commands and remaining limitations are documented in the root README.

### Prompt 5 checkpoint (history)

- Profile first, then use Visualize field controls and explicit rendering for histogram, box plot, bar, line, scatter, heatmap, correlation and missingness. Model-result remains an untrained placeholder. Data/chart linked marks, independent chart/chart panes and shared-encoding filtered variants preserve original data. Configuration CRUD is capped at 100 per dataset and bound to its current version; comparison specifications persist across reloads.
- Sampling, referenced-field projection, mark/category/facet limits, linked-table and result caps are documented in the [root README](../README.md#local-data-workbench). Filters and aggregates describe only the bounded sample, not population estimates. Panes run sequentially through the existing cancellable analytical worker. JSON includes the specification and frozen result; exported Python plots those frozen aggregates/observations rather than transforming source data. Exports may disclose bounded dataset observations and labels.
- All 164 focused workbench tests passed across the 19 test files listed in the README, including six chart test files; `npm run check` passed. SVG, HTML and JSON export safety is covered by real-DOM tests.
- Actual browser smoke covered an 80-row full result and a 2,500-of-5,000-row sampled result; all eight chart types and the untrained placeholder; scatter color/size/facet controls, data/chart linked marks, chart/chart, filtered variants and reload persistence; saved-configuration create/load/update/duplicate/rename and confirmed deletion; and 390px mobile layout without page overflow.
- Browser downloads completed for PNG (293,051 bytes), SVG (36,100 bytes), standalone HTML (92,353 bytes) and JSON (47,615 bytes). Standalone HTML rendered with no scripts or remote resources. All eight exported Python chart scripts exited successfully with matplotlib 3.10.3; the Agg backend emitted expected noninteractive `show` warnings. This was external export verification, not application Python execution.
- No AI-provider calls, model training, arbitrary transformations or application Python execution were enabled. Prompt 5 is complete; stop before Prompt 6 pending approval.

### Prompt 6 checkpoint (history)

- Public Pi SDK integration lives in `assistant-driver.ts` and `assistant-sdk-worker.ts`, launched through the existing tsx/root source-alias workflow. No Pi core changes. Fresh in-memory sessions use no tools or ambient resources; the public session system prompt is compared with the exact approved text before generation. The virtual working directory is fixed and nonsensitive.
- `assistant-context.ts` explicitly selects metadata/statistics; `assistant-validation.ts` rejects unknown fields, unsupported charts, fabricated evidence IDs, undisclosed columns and model-owned lifecycle state. Rows, samples, storage paths and previous turns are never attached. Evidence linkage does not verify an interpretation; the UI labels inference/hypothesis status.
- `assistant-service.ts` manages bounded, expiring, single-use approvals, one active generation, progress counts, usage, cancellation and safe failures. Metadata schema 4 persists scoped runs and recovers interrupted work. Applying/reverting a suggestion atomically changes only its owned chart configuration, protecting edited charts and preserving original data.
- Provider keys are explicit literal values held only in server memory. No ambient Pi/environment credentials, OAuth, custom endpoints or credential command expansion. Offline discovery exposed 450 models across eight supported providers with zero configured credentials in the actual subprocess smoke.
- Actual browser smoke exercised three-field disclosure without private cells, approval, completed suggestions, local chart preview/save/open/revert, malformed-output rejection, cancellation, and a 390px viewport without horizontal page overflow. The browser used a clearly identified offline test driver; actual SDK generation is exercised separately with Pi's deterministic faux provider. No paid provider inference was performed.
- Final validation passed 64 assistant tests across six files and 73 affected existing regression tests across eight files (137 total), plus `npm run check` with Node/DOM typechecking and browser bundling. The refreshed application listed all eight supported providers as unconfigured and disabled preparation without credentials. Temporary smoke data was separate from the normal application store.
- Limits and usage are in the root README. SDK process separation and a JavaScript heap limit are not a sandbox. Generated code remains inspect-only. Stop before Prompt 7 pending approval.

### Prompt 7 current checkpoint

- `transform-contracts.ts`, `transform-spec.ts` and `transform-engine.ts` define fixed, validated operations: rename/cast/drop, row filters, missing-value handling, deduplication, category mapping, datetime extraction, scaling, encoding and structured derived expressions. Application-generated DuckDB SQL is inspectable; arbitrary SQL, Python, JavaScript and model-generated code are not executable.
- **Data → Transform → Preview full-dataset impact** computes the complete output artifact and exact affected-row, row-count, schema and NULL-count impact. At most 20 first input/output rows are illustrative samples, not an aligned diff. Numeric conversions/arithmetic disclose double-precision approximation; unchanged source text remains exact. Missing-value policy distinguishes SQL NULL from empty string.
- Applying requires separate approval bound to the exact preview, current version, timeline revision and immutable input/output hashes. It publishes the staged artifact without mutating original uploads. Cancellation, expiry, failures or stale context publish no active version. Undo/redo changes the active immutable version and persists across restart; a new apply clears redo while retaining provenance and prior versions.
- Limits: 24 KiB specifications, 4 MiB impact reports, 512 output columns, 128 map entries/categories and 128-node/depth-16 derived expressions. At most four previews across the local store expire after ten minutes with restart-safe draft bookkeeping. Per dataset: at most 100 retained versions, 100 audit records and a 16 MiB audit budget; admission reserves result space and rejects new work rather than pruning provenance. Existing record/decoded-output/artifact limits and the five-minute, 1 GiB Windows JobObject resource boundary apply. Source and target DuckDB instances each have a 256 MiB buffer and 512 MiB spill allowance. This is not a filesystem/network or arbitrary-code sandbox.
- Profiles, previews, charts and assistant context follow the selected version. **Recompute current profile** on a transformed version reads its current artifact, not the original upload. Version-bound chart configurations and stale assistant proposals cannot silently target a different version. **Accept → Review transformation** fills the local form only; the user must still preview, review and explicitly approve. Assistant generated code remains inspect-only and inference still uses Prompt 6's fresh in-memory session behavior until a separately approved redesign.
- Actual browser smoke covered preview, filling missing values with `0`, apply, undo, redo, reload and transformed-artifact reprofiling, with desktop and 390px layouts showing no page overflow. An offline assistant proposal exercised Accept → Review without data mutation or enabled Apply. A production CLI restart against the same fixture retained transformed version/history; Undo restored the original empty string and Redo restored the transformed version, with no visible errors. Owned smoke servers and temporary fixture data were removed. No paid inference was used.
- Final focused validation passed 205 unique tests: 55 engine/spec/server/assistant/UI tests across six files, seven transformation-storage tests, 132 affected regression tests and 11 assistant-driver tests. The corrected storage file passed its final seven-test rerun. The driver tests exercised the actual subprocess's offline catalog, cancellation, hostile credentials/input limits and the real SDK with a deterministic faux provider. Final `npm run check` passed with zero fixes or errors. Commands and user-facing limits are in the root README.
- Prompt 7 is complete. Pi conversational-session research produced the reuse plan below, not an implemented chat feature. The next implementation is that bounded assistant redesign, not a separate chat engine or Prompt 8.

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
| `packages/workbench` | Private local workbench through Prompt 7: shell, ingestion, profiles, charts/comparisons, explicitly approved read-only assistant suggestions and locally previewed fixed transformations with immutable versions/undo. Arbitrary execution and later stages remain gated. |

Existing browser artifacts include `packages/coding-agent/src/core/export-html` and `scripts/tool-stats.ts`. A static transcript export or tool-usage chart report is not a live workbench or reusable data-charting engine.

## 3. Agent launch and integration choices

### Recommended: public Node SDK behind an application adapter

`packages/coding-agent/src/index.ts` exports the supported SDK. `createAgentSession` in `src/core/sdk.ts` accepts `modelRuntime`, `model`, `sessionManager`, `settingsManager`, `resourceLoader`, `customTools`, and explicit tool selection. It returns an `AgentSession` plus extension-loading results.

Public session operations include `subscribe`, `prompt`, `abort`, `waitForIdle`, and `dispose`. Use settled/idle semantics for turn completion rather than assuming every `agent_end` means all work finished. `defineTool` plus TypeBox parameters provides typed custom tools with cancellation, progress updates, and structured result details.

Implemented Prompt 6 assistant configuration, still current after Prompt 7 (narrower than the original later-tool proposal; conversational redesign pending review):

- Explicit empty tool allowlist. No read/bash/edit/write defaults or application tool execution.
- Fixed resource loader and in-memory settings. No ambient extensions, skills, command expansion or context files.
- Application-owned SQLite run history; each inference uses a fresh `SessionManager.inMemory` and no previous messages. This prevents previously approved metadata from being retransmitted implicitly.
- `ModelRuntime` receives an explicit in-memory credential store, no models.json and no catalog-network refresh. Browser selection uses validated built-in provider/model IDs. Keys are server-memory only.
- Only the exact approved system/user metadata envelope goes to the model. The SDK supplies provider protocol/authentication wrappers; those are not represented as dataset context.
- Chart previews and validated transformation proposals use existing local analytical operations after validation; results are not sent back to a provider. Transformation acceptance only fills review controls, with a separate local preview and approval before publication. Arbitrary tools or code remain unavailable.

`SessionManager.create`, `open`, `continueRecent`, `list`, and `inMemory` are supported. Resume through these factories, not an invented `continueSession` SDK option. Lower-level `SessionRepo`/SQLite objects are different APIs.

### Conversational assistant reuse plan (not implemented)

Problem: the current adapter deliberately discards Pi's conversation capabilities. `assistant-sdk-worker.ts` creates `SessionManager.inMemory`, rejects nonempty history or tools, emits character counts instead of text deltas, accepts only one final assistant response, then disposes the session. A follow-up therefore cannot refer to an earlier answer. Replacing the browser form alone would not fix this.

Decision: retain the public Node SDK and existing subprocess boundary, but let Pi own the conversation. Do not introduce a second agent loop, transcript database or raw browser RPC service.

User experience: normal chat uses **Send**, not a second approval dialog. Approve dataset sharing once for the conversation and provider, then chat and follow up within that scope. Show a compact provider/shared-datasets/no-rows indicator with expandable sharing details; exact payload inspection remains available, not mandatory. Confirmation is reserved for a new provider or expanded data-sharing scope, and a separate explicit Apply after local transformation preview. A model/tool continuation within the approved scope must not interrupt the user.

- Keep a project-scoped Pi session identity mapped to an application-owned path. Use public `SessionManager.create`/`open` factories and an explicit private session directory; never accept a browser-supplied filesystem path or use global most-recent-session discovery. Pi's session file owns message history; SQLite owns project association, approval records and analytical artifacts.
- Change the fixed SDK child from one-request-then-exit to a bounded session lifecycle with explicit open, prompt, abort and close messages. Reuse `session.prompt`, `subscribe`, `abort` and `waitForIdle`; reconnect loads persisted state rather than replaying the prompt. Session switching must settle/abort the previous turn and replace subscriptions. Keep existing memory-only provider credentials and disabled ambient resources.
- Normal cancellation must leave the session reusable; disposal belongs to close/shutdown, with a bounded forced-stop fallback. Reset per-turn output/deadline accounting and bound accumulated history separately. Credential deletion/change must update or terminate the retained child, not leave an old credential snapshot usable. Pi defers a new session file until an assistant message exists: record interrupted pre-response work in application lifecycle metadata, never replay it automatically. Persisted aborted or invalid assistant content is not a validated action; if retained as conversational history, it remains subject to the same sharing scope and bounds, without a new approval dialog merely because a turn ended.
- Forward bounded `message_update`/`text_delta`, message lifecycle and `tool_execution_start`/`update`/`end` events into the existing browser assistant. Render a persistent transcript and follow-up composer with visible cancellation, sharing-scope changes and error states. Pi remains responsible for the actual agent/tool loop. Treat assistant text as untrusted text, and validate actionable proposals separately.
- Treat `agent_settled`/`waitForIdle` as completion, not every `agent_end`. For queued follow-ups use `prompt` with `expandPromptTemplates: false` and Pi's `streamingBehavior`, rather than reimplementing its queue or accidentally enabling template/skill expansion.
- Add only typed chart/transformation proposal tools through public `customTools`/`defineTool`. Reuse existing specification and evidence validation. Tools may produce review cards, never apply changes. Existing local preview/apply/undo remains authoritative. Full before/after samples and analytical artifact contents must not become tool results sent back to the provider.
- Store a session-scoped sharing grant bound to the project/conversation, provider recipient, explicit immutable dataset versions, selected fields and allowed metadata/statistics. Granting access explains that conversation messages and approved context are reused for follow-ups. Pressing Send authorizes the user's new message within that scope; ordinary assistant replies, safe proposal-tool acknowledgements and follow-ups do not require repeated confirmation. No automatic row/sample/file access is granted.
- Adding a dataset, new version, additional fields or other newly disclosed metadata requires a concise before/after sharing summary and confirmation. Switching provider must disclose that the conversation history will go to the new recipient before sending. Model-driven requests cannot expand the grant. A model switch alone does not require confirmation if the recipient and disclosure scope are unchanged.
- Validate every outgoing request automatically against the current grant and a stable context revision. A changed revision requires rebuilding/rechecking the request, not asking again when it remains in scope. Bind explicit expansion approvals to the grant revision and recipient so stale approvals cannot authorize newer context. Keep a validated record of where attachments and tool results came from; do not infer sharing permission by scanning free-form strings. Persist scope across reload/restart, with an explicit revocation control that stops pending and future sends. Removing an attachment stops adding its context but does not erase earlier messages or information already sent; to stop reusing that history, end/revoke the conversation and start a clean one.
- Keep local result details out of model-visible messages: a hidden custom message (`display: false`) is still sent by Pi. Tool acknowledgements should contain safe proposal IDs or explicitly approved metadata, not preview rows, provider errors or filesystem paths. Removing a field from the current selection does not remove it from earlier history; the review must make that distinction visible.
- The `before_provider_request` extension event is **not a security gate**: `ExtensionRunner.emitBeforeProviderRequest` catches handler exceptions and continues with the payload. `PromptOptions.preflightResult` reports acceptance, not privacy approval. The proposed gate wraps the captured public `session.agent.streamFunction`, preserves the SDK wrapper and supplies a provider `onPayload` hook that automatically permits in-scope requests and rejects unauthorized ones before network dispatch. It is not a per-request approval UI. Unexpected context must stop with a useful error; only an explicit user sharing change may request an expanded grant. Cancellation/revocation must observe the stream options' signal and the current grant while a request is pending. Verify this behavior against every supported provider path before enabling it; do not rely on an exception thrown from an extension handler or from `StreamFn` itself.
- Keep the existing disabled automatic retry/compaction settings. Compaction and branch summaries use standalone model calls and can bypass ordinary context hooks; any later enablement must go through the same consent boundary and have its own verification. Exceeding the context limit should produce an explicit actionable state, not hidden summarization or discarded history.

Expected existing-file scope under `packages/workbench`: `src/assistant-{contracts,context,validation,driver,sdk-worker,service}.ts`, `src/{metadata,storage,server}.ts`, `src/browser/{assistant,app}.ts`, browser HTML/CSS, the corresponding assistant/storage/server/browser tests and existing SDK proof fixture. Exact helper extraction is an implementation decision, not a new framework. No Pi core/public API changes or Prompt 8 code execution are proposed.

Acceptance: a real two-turn conversation retains context after browser reload and process restart; approved scope permits ordinary Send, follow-ups and safe tool continuations without repeated approval prompts; new providers or expanded disclosure require confirmation before any send; revoked or stale grants permit zero further unauthorized sends. Real text streams incrementally; cancellation works during generation and scope confirmation; reconnect does not duplicate a turn; project/session isolation holds; malformed tool output creates no action; proposals still require local preview and explicit Apply; no dataset rows, ambient files or credentials are attached to provider context. The sharing indicator and optional inspector must accurately distinguish current attachments from previously shared history. Use the existing deterministic faux provider and browser surface for proof. Current investigation reran the existing SDK-driver contracts (11 passed), not these new multi-turn contracts.

Implementation order for the later pass:

1. Extend session/turn contracts and persistence, then retain the Pi worker across turns. Prove scoped resume, cancellation and credential revocation before connecting the browser.
2. Implement automatic outbound scope enforcement with offline provider/transport tests. In-scope follow-ups/tool continuations require no new consent; denied, cancelled, revoked or stale scope expansions cause zero unauthorized sends. Preserve all currently supported providers; do not silently narrow support.
3. Connect bounded text/tool events to the transcript and follow-up composer, add the compact sharing indicator and confirmation only for scope/recipient changes, then route validated proposal tools into the existing local preview/Apply controls.
4. Exercise two-turn conversation, restart, reconnect, isolation and approval in the real browser; run focused assistant contracts and `npm run check`. This is a complete chat feature, not an independently shipped protocol scaffold.

Source anchors: `packages/coding-agent/docs/sdk.md` (session/event/custom-tool APIs), `src/core/extensions/runner.ts` (`emitContext`, `emitBeforeProviderRequest`), and the existing workbench SDK worker/driver proof. This is the next bounded feature plan; implementation is deferred to a later pass under the user's permitted plan-first checkpoint, with Prompt 8 still on hold.

### Alternatives and why they are not the default

| Boundary | Benefits | Costs and decision |
| --- | --- | --- |
| Direct SDK | Supported TypeScript API; existing lifecycle, custom tools and session persistence; fewer translation layers. | Runs host-side with host permissions. Choose this behind a narrow application adapter, not in browser components. |
| JSONL RPC subprocess | Supported `pi --mode rpc`; process separation and language-independent host integration. | A subprocess is not a sandbox. Raw RPC includes shell and filesystem-path commands; never expose it directly to a browser. Prefer only if process ownership requirements justify the adapter. |
| `RemoteSession` → `PiClient` → CBOR → `PiServer` | Existing snapshots, progress projection, leases, reconnect and conformance tests. | Explicitly experimental; missing browser transport and production SDK/service adapter. Adopting it now adds work unrelated to Prompt 2–3. Revisit at assistant integration if its reuse outweighs compatibility and adapter costs. |

JSONL RPC and framed CBOR are different protocols. A command response may mean accepted/queued, not completed. Local exclusive client leases are not user authorization.

## 4. Proposed architecture and data flow

The architecture choices below were approved before implementation; later-stage integrations still require their own approval.

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
| Approved architecture | One workbench workspace; native DOM/CSS + esbuild shell; later direct public SDK integration; SQLite application metadata; DuckDB analytical process. |
| Verified at Prompt 3 | Windows native ingestion/preview, memory enforcement and lifecycle, bounded response/decoded data, Parquet precision/list values, and observed near-limit artifact usage. DuckDB spill configuration is not an OS-wide disk quota. |
| Verified at Prompt 6 | Empty SDK tools/resources, server-memory credentials, exact model-visible context, schema validation, scoped history, cancellation and offline SDK/faux-provider operation. Live external inference was not exercised. |
| Verified at Prompt 7 | Full-dataset fixed operations, exact impact and bounded samples, preview-bound approval, immutable publication, persistent undo/redo, transformed-artifact reprofiling and assistant handoff without automatic execution. The worker resource boundary is not a code/filesystem/network sandbox. |
| Plan ready, not implemented | Reuse Pi conversational sessions/lifecycle behind the existing workbench privacy boundary. Current assistant turns remain independent; no standalone chat engine or implicit sharing of previous approvals. Prompt 8 stays on hold. |
| Needs validation before generated code | Available Windows-compatible OS sandbox/runtime and fail-closed execution proof. Neither worker_threads nor subprocess RPC is enough. |
| Deferred, not omitted | Hosted identity provider, deployment platform, shared database/blob storage, quotas, billing if ever needed. Decide at multi-user/deployment stages, not now. |

## 7. Milestones and stage gates

Prompts 1–7 have been approved and implemented. Pi conversational-session reuse is now planned below for a later implementation pass, as permitted by the user. Read each later prompt immediately before its separately approved stage; do not advance automatically.

| Stage | Bounded deliverable and exit gate |
| --- | --- |
| 0 | Existing persistent project instructions reconciled; no duplicate rule file. |
| 1 | Completed source-grounded plan; architecture approved. |
| 2 | Three resizable panels, requested center/right tabs, palette, themes, persistent layout and accessibility. Clearly labelled shell-only view models where needed. Browser proof and component behavior tests; no ingestion expansion. |
| 3 | Project/dataset entities, CSV and Parquet streaming ingestion, immutable sources, hashes, bounded analytical previews, progress/cancel/retry, safe failures and project scoping. Reconcile provisional storage rather than declare it sufficient. |
| 4 | Deterministic versioned profiles and quality evidence, richer statistics/semantic candidates, exact-vs-approximate labels, cache keys and cancellation. Provisional min/max/counts are not the complete stage. |
| 5 | Completed deterministic visualization studio and side-by-side comparison; version-bound chart specifications, bounded aggregation, native SVG rendering and exports. Verification recorded above. |
| 6 | Pi read-only assistant and evidence-based proposals through the approved boundary, explicit context-sharing preview and validation. No arbitrary transformation execution. |
| 7 | Completed fixed full-dataset transformations, exact impact and bounded first-row samples, preview-bound approval, immutable versions and persistent undo/redo. Current proof recorded above; arbitrary generated code remains unavailable. |
| Before 8 | Source-grounded Pi conversational-session reuse plan complete. Implement persistent chat, streaming and proposal-tool activity within its privacy boundaries; current assistant remains fresh-session until that change. |
| 8 | On hold. Code workspace with independently verified OS-isolated execution; no host fallback. Requires separate approval after the conversational review. |
| 9 | Guided modeling with explicit experiment/run specifications. Read full stage requirements before implementation. |
| 10 | Reports and project history, reproducible artifact references and export. |
| 11 | Separate approved multi-user migration: authentication, authorization and quotas. |
| 12–14 | Production threat/failure review, deployment design, then final product audit. Separate prompts and acceptance checks. |

Local checkpoint: stages 2–7 provide inspect/profile/compare/ask/transform with explicit local approval and no arbitrary code. The planned conversational assistant is next; stages 8–10 remain deferred, not silently dropped. Each later stage has its own plan, exact expected files, tests and approval/stop gate.

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
- Shell: component behavior for splitter persistence, tabs, command palette, focus and keyboard navigation; actual browser screenshots/interaction at desktop and tablet widths, error/loading/empty states and no page overflow. Reuse the established workbench DOM test harness.
- Ingestion: fixture-based CSV/Parquet correctness, adversarial filenames/content, strict limits, bounded output, cancellation during upload/parse/publish, retry, restart and no cross-project lookup. Browser-drive the complete create/import/inspect/restart flow; include a near-limit file and observe memory/disk behavior.
- Profiles/charts: known numerical fixtures, exact/approximate flags, deterministic cache invalidation, operation/spec round-trips, provenance and bounded exports. Test returned behavior, not source text or implementation details.
- Assistant: reuse existing SDK/faux-provider conventions, no real paid tokens. Test safe context construction, malicious names/cells, structured-output rejection, unsupported claims, session isolation and cancellation. Existing remote-session/projector tests are reusable if that stack is selected.
- Transformations: strict validated specifications, whole-dataset numerical/row semantics, exact impact with bounded nonaligned samples, immutable hashes, preview expiry/cancellation, publication failure, stale approval, retained provenance and undo/redo across restart. Browser-drive manual and assistant-proposed operations; accepting a suggestion must not automatically preview or apply it.
- Execution: adversarial filesystem/network/environment tests inside the actual target sandbox, hard resource/deadline termination, no fallback and output validation before enabling the feature.
- After each approved code stage: narrow relevant tests, actual surface smoke, then `npm run check` with full output. Do not run root `npm test`, full Vitest, or builds without the repository's required authorization. Preserve unrelated work if formatters encounter it.

## 10. Verified development commands

Commands below are verified from manifests/scripts, not all executed. Run from the repository root unless a package directory is shown. Use Node >=22.19.0; the Gondolin example has a higher requirement and is not needed for these stages.

| Command | Meaning and caveat |
| --- | --- |
| `npm install --ignore-scripts` | Hydrate workspace dependencies without lifecycle scripts. Executed before Prompt 1. |
| `npm install --package-lock-only --ignore-scripts` | Refresh lockfile after reviewed dependency metadata changes. Prompt 6 adds existing workspace AI/SDK dependencies and pinned tsx; no lifecycle scripts. |
| `npm run check` | Biome **writes formatting/fixes**, then dependency/import/lock checks, root Node tsgo, browser DOM typecheck and browser bundling. Not a test suite. |
| `npm run hydrate:model-data` | Root delegates to AI strict data-only catalog hydration. Network access required; writes ignored provider JSON, not a reason to edit `models.generated.ts`. Source-supported repair for missing data; not run during Prompt 1. |
| `npm run check:model-data` | Validates hydrated model data. Does not replace narrow product tests. |
| `npm run check:browser-smoke` | esbuild browser compatibility/tree-shaking check, **not** a UI browser test. |
| `npm run dev:workbench` | Local launcher: `node packages/workbench/src/cli.ts`; defaults to loopback port 4310 and `~/.datapi/workbench`. Assistant launches its fixed SDK subprocess lazily. |
| `npm run dev:workbench -- --port 4310 --data-dir <directory>` | Launcher with explicit data root. Placeholder must be replaced by a real path. |
| `npm run typecheck --workspace=@earendil-works/pi-workbench` | Browser sources/tests and their shared contracts with DOM types. Root tsgo covers server/SDK sources and Node tests separately. |
| Focused `node --test` commands in the root README | Original ingestion/profile/chart/shell coverage, assistant contracts and five transformation files. SDK tests use a deterministic faux provider and require no paid credentials. Current checkpoint counts describe executed files, not a claim that every listed command was rerun. |
| `node ../../node_modules/vitest/dist/cli.js --run test/client/remote-session.test.ts` from `packages/coding-agent` | Existing focused public-client contract test; command/path verified, not run in this audit. |
| `node --test test/specific.test.ts` from `packages/tui` | Repository pattern; replace `specific.test.ts` with a verified target. |
| `./test.sh` | Root Bash wrapper that isolates environment/config and invokes non-provider-dependent tests. Requires Bash on Windows; arguments are not a file filter. Not run. |
| `.\pi-test.ps1` / `.\pi-test.ps1 --mode rpc --no-session` | Existing Windows source launch via tsx. Provider/model/generated-data prerequisites still apply. Not run. Avoid `--no-env` for a clean RPC stream: it prints a banner and is not complete credential isolation. |
| `pi --mode rpc --no-session` | Installed/built CLI JSONL RPC launch, not the experimental CBOR protocol. Requires actual CLI installation. |
| `npm run dev --workspace=@earendil-works/pi-server` | TypeScript watch only; does **not** launch an application server. |
| `npm run build` / `npm run build:offline` | Existing ordered package builds. Offline requires hydrated data; neither is authorized or run by this documentation stage. |

There is no generic root `dev` web-server command beyond the workbench launcher. The assistant establishes source execution through a fixed tsx subprocess with root aliases; it does not require built `dist` artifacts. Root checking covers Node/SDK code, and the workbench DOM configuration separately covers browser sources/tests without pulling server-only SDK modules into DOM globals.

Official analytical-client evidence: [DuckDB Node Neo overview](https://duckdb.org/docs/current/clients/node_neo/overview.html) documents the high-level `@duckdb/node-api` package and Windows x64 support. Local ingestion and fixed analytical-worker verification are recorded in the stage checkpoints above; future execution boundaries still require their own proof.

## 11. Approval gate

Approved architecture choices (recorded before Prompt 2):

1. One private `packages/workbench` application; no Pi core/public-API changes.
2. Native TypeScript DOM/CSS + esbuild for the three-panel shell.
3. Public Node SDK host adapter for later assistant integration, with custom-tool allowlist and controlled resources; no raw browser RPC.
4. SQLite application metadata plus immutable local files; DuckDB analytical worker for CSV and Parquet at Prompt 3.
5. Fixed operations first; generated Python/shell only after a verified fail-closed OS sandbox.

Preserve uncommitted implementation and source data. Do not automatically create branches or commit existing work; the worktree also contains the user's prompt file. Agree on checkpoint/branch action before doing either.

Prompt 7 acceptance and the conversational-session reuse plan are complete. The user explicitly permitted rewriting the chatbox plan first and implementing later; this pass takes that checkpoint because preserving privacy across prior turns and tool calls requires a verified outbound-request gate. Next implement the bounded plan above using Pi's existing session engine, not an independent chat engine. The current assistant still uses fresh independent sessions. Prompt 8 and every later prompt remain separately approval-gated.
