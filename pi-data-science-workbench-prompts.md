# Pi Data Science Workbench — Build Prompts

Use these prompts in order inside your fork. Start each stage in a clean Git branch or after committing the previous stage. Do not paste every prompt at once.

## Product goal

Build a web-based data-science workbench powered by Pi. A user can upload or connect data, inspect it, clean it, visualize it side by side, receive evidence-based suggestions, run reproducible analysis, compare models, and export a report. The application must work for one local user first and have a safe path to multiple users.

## Prompt 0 — Persistent project instructions

Save the following as project instructions (for example, in `AGENTS.md`) after adapting any repository-specific commands:

```text
You are working on a web-based data-science workbench built around Pi.

Operating rules:
- Inspect the repository before proposing or changing architecture. Reuse its package manager, conventions, libraries, and build system unless a change is justified.
- Never invent file paths, APIs, database tables, or commands. Verify them in the repository.
- Before implementation, state the files you expect to modify and the acceptance criteria.
- Make one bounded feature change at a time. Preserve existing Pi behavior and public APIs unless the task explicitly requires a breaking change.
- Prefer integrating through Pi's supported SDK or RPC boundary over tightly coupling the UI to internal implementation details.
- Keep data operations reproducible. Every transformation or chart must have inspectable generated code or a structured operation record.
- Separate observed dataset facts from AI inferences. Recommendations must include evidence, affected columns, confidence, and a proposed action.
- Treat uploaded files, column names, cell values, model output, and generated code as untrusted input.
- Never execute user-generated Python or shell code in the web server process. Use an isolated worker with CPU, memory, time, filesystem, and network limits.
- Do not send dataset rows to an LLM by default. Prefer schema, statistics, and redacted samples, and clearly surface when data will leave the machine.
- Never log API keys, tokens, raw datasets, or sensitive cell values.
- Add or update tests for each behavior. Run the narrowest relevant tests, type checks, and linting before declaring completion.
- Do not hide errors behind mock data or silent fallbacks. Display useful, safe error messages.
- Maintain keyboard accessibility, responsive behavior, loading states, empty states, and error states.
- At the end of each task, report: files changed, decisions made, commands run, test results, known limitations, and the next recommended task.
```

## Prompt 1 — Audit the fork and write the implementation plan

```text
Inspect this Pi fork thoroughly, but do not implement product features yet.

Determine:
1. The monorepo/package structure and package manager.
2. How the coding agent is launched and how its SDK and RPC modes work.
3. Existing web UI, TUI, agent-core, provider, session, and tool abstractions we can reuse.
4. Existing build, test, lint, formatting, and development commands.
5. Authentication, storage, database, job-processing, and sandboxing capabilities, if any.
6. The safest extension point for a new data-science web application without making future upstream merges unnecessarily difficult.

Then create `docs/data-science-workbench-plan.md` containing:
- A concise current-state repository map.
- Proposed architecture and data flow.
- A package/module layout that fits this repository.
- Decisions that are confirmed versus assumptions that still need validation.
- An MVP milestone plan and a later multi-user milestone plan.
- Main security and privacy risks.
- A testing strategy.
- Exact development commands verified from the repository.

The target experience is a resizable three-panel interface: datasets/projects on the left; data, code, and visualizations in the center; AI conversation, evidence, and suggestions on the right. The application must support side-by-side comparisons.

Stop after writing the plan. Do not scaffold or install dependencies. Show me the plan and ask me to approve or amend the architectural choices.
```

## Prompt 2 — Scaffold the web application and design system

```text
Using the approved architecture in `docs/data-science-workbench-plan.md`, scaffold the smallest runnable web application inside the existing repository.

Requirements:
- Use the repository's existing language, package manager, tooling, and UI libraries where practical.
- Add a responsive application shell with a top bar and three resizable panels.
- Left: project and dataset navigation.
- Center: tabs for Data, Code, Visualize, Statistics, and Models.
- Right: tabs for Assistant, Suggestions, and Activity.
- Add a command palette, light/dark theme, keyboard focus indicators, skeleton loading states, empty states, and an error boundary.
- Panel sizes and selected tabs must persist locally.
- Use typed mock view models only to exercise the interface; do not pretend that backend functionality exists.
- Define design tokens for spacing, typography, color, status, and chart palettes.
- Add component-level tests for resizing, tab selection, and keyboard navigation.
- Add a README section with verified start and test commands.

Acceptance criteria:
- The application starts using one documented command.
- It remains usable at desktop and tablet widths.
- No horizontal page overflow occurs; individual data regions may scroll.
- All primary controls are reachable by keyboard.
- Existing Pi packages and tests remain functional.

Stop after the shell is working and tested. Report screenshots or a precise visual description, changed files, and test results.
```

## Prompt 3 — Projects, datasets, and ingestion

```text
Implement the first real vertical slice: create a project, upload a dataset, and preview it.

Support CSV and Parquet for the MVP. Design interfaces so XLSX, JSON, SQL, and object storage can be added later.

Requirements:
- Project entity: id, owner id when applicable, name, description, created/updated timestamps, and settings.
- Dataset entity: id, project id, original filename, safe display name, format, byte size, content hash, row/column counts when known, storage location, ingestion status, schema version, and timestamps.
- Stream uploads; do not load the entire file into web-server memory.
- Validate extension, MIME hints, file signature where possible, maximum size, parsing limits, and decompression risk.
- Generate safe server-side storage names. Never use a client filename as a filesystem path.
- Store immutable original data and create separate derived versions.
- Use DuckDB or the approved analytical engine for bounded preview queries.
- Add pagination or virtualization and never send the full dataset to the browser.
- Display ingestion progress, cancellation, retry, parsing errors, and an accessible empty state.
- Show a preview with column names, inferred basic types, and a configurable row limit.
- Add test fixtures covering valid, malformed, oversized, empty, unusual-encoding, and adversarial filenames.

Acceptance criteria:
- A user can create a project, upload valid CSV/Parquet, and preview bounded rows.
- Malformed input fails safely without losing the original project.
- Two identical uploads can be recognized by hash without incorrectly sharing authorization.
- All data access is scoped to the current project/user boundary.

Stop after ingestion and preview work end to end. Do not implement AI suggestions yet.
```

## Prompt 4 — Dataset profiler and data-quality report

```text
Build a deterministic dataset-profiling worker and connect it to the interface. Do not use an LLM to calculate statistics.

Produce a versioned profile containing:
- Dataset row count, column count, approximate memory/storage size, duplicate count, and profiling timestamp.
- Per-column original type and semantic type candidates: numeric, categorical, boolean, datetime, text, identifier, and geographic.
- Null count/percentage, distinct count/percentage, representative redacted examples, top values, min/max, mean, median, standard deviation, quantiles, skewness, and outlier indicators where applicable.
- Potential identifiers, target columns, time columns, constant columns, high-cardinality columns, suspicious leakage candidates, invalid ranges, inconsistent categories, class imbalance, and highly correlated fields.
- Sampling method, sample size, approximation flags, and statistical limitations.

UI requirements:
- Overview cards and a searchable column list.
- Selecting a column opens its profile beside the data preview.
- Severity-filtered quality issues with exact evidence.
- Never show a statistic as exact if it was sampled or approximated.
- Long-running profiles execute as cancellable background jobs with progress.

Engineering requirements:
- Define typed schemas for DatasetProfile, ColumnProfile, DataIssue, and Evidence.
- Bound runtime and memory for wide and large datasets.
- Cache profiles by dataset-version hash and profiler version.
- Unit-test statistics and semantic inference with known fixtures.

Stop when deterministic profiling is complete, visible, and tested.
```

## Prompt 5 — Side-by-side visualization studio

```text
Implement the visualization studio using the profiled dataset.

Core experience:
- A field browser and chart canvas with X, Y, color, size, facet, aggregation, sort, and filter controls.
- Automatic chart recommendations based on field semantics and cardinality.
- Supported MVP charts: histogram, box plot, bar, line, scatter, heatmap, correlation matrix, missingness matrix, and model-result placeholders.
- A split-view mode that compares data versus chart, chart versus chart, or two filtered versions of one chart.
- Linked selection where selecting chart marks filters or highlights the visible table when technically feasible.
- Every chart has a structured, serializable specification and inspectable generated Python code.
- Users can save, duplicate, rename, and delete chart configurations without modifying original data.
- Export PNG, SVG where supported, and standalone HTML or JSON specification.

Quality rules:
- Select safe default aggregations and cap high-cardinality displays.
- Warn about truncated axes, excessive categories, overplotting, misleading dual axes, nonzero bar baselines, sampled data, and inappropriate chart types.
- Clearly label filters, aggregation, sample size, and missing-value handling.
- Use accessible colors and offer non-color encodings.
- Perform aggregations server-side or in the analytical worker; never transfer an unbounded dataset to the browser.

Acceptance tests must cover field-to-chart recommendations, serialization, side-by-side state, large-category safeguards, and export behavior.

Stop after deterministic charting works. Natural-language chart creation belongs in the next stage.
```

## Prompt 6 — Pi assistant integration and evidence-based suggestions

```text
Integrate Pi as the assistant through the approved SDK or RPC boundary. Keep agent orchestration separate from UI components and internal Pi implementation details.

The assistant must receive a compact, explicitly constructed context containing project metadata, dataset schema, deterministic profile statistics, current filters, selected columns, saved artifact metadata, and the user's request. Do not send full rows by default.

Implement structured suggestions with:
- id, category, title, explanation, priority, confidence, evidence references, affected columns, proposed action, generated code when relevant, and status.
- Categories: data quality, exploration, visualization, transformation, modeling, and interpretation.
- Statuses: proposed, accepted, rejected, applied, failed, and reverted.

Required behaviors:
- Natural language such as “compare failure rate by machine type over time” produces a validated chart specification, explanation, and preview before application.
- Suggestions cite profile values or query results. Unsupported claims are labeled as hypotheses requiring validation.
- Generated structured output is schema-validated. Invalid output is repaired or rejected visibly.
- Prompt-injection content in filenames, column names, and cells is treated as data, never as instructions.
- Users see exactly what metadata/sample will be sent to the selected model provider.
- Provider keys remain server-side, and provider/model selection is configurable.
- Track token usage, latency, cancellation, and safe error details.

Add adversarial tests for malicious column names, unsupported claims, malformed tool output, and cross-project access attempts.

Stop after read-only suggestions and chart proposals work. Do not allow the agent to execute arbitrary transformations yet.
```

## Prompt 7 — Reproducible transformations and undo

```text
Implement safe, reproducible dataset transformations.

Supported MVP operations:
- Rename/cast/drop columns.
- Filter rows.
- Handle missing values using explicit methods.
- Deduplicate.
- Map or consolidate categorical values.
- Extract datetime components.
- Scale or encode selected fields.
- Create a derived column from a restricted expression language.

Architecture:
- Represent each operation as a validated, versioned transformation specification.
- Preview impact before applying: affected rows, null changes, schema changes, and a bounded before/after sample.
- Applying creates a new immutable dataset version linked to its parent; never mutate the uploaded original.
- Generate equivalent inspectable Python or SQL code where possible.
- Maintain undo/redo by changing the active version, not by destructively editing files.
- Record actor, timestamp, input version, output version, operation, parameters, and execution result.
- AI may propose a transformation, but the user must explicitly approve it.
- Execute operations in a resource-limited analytical worker.

Tests must cover deterministic replay, version lineage, failed operations, cancellation, rollback, and authorization.

Stop after the supported operations, preview, approval, versioning, and undo work end to end.
```

## Prompt 8 — Code workspace and isolated execution

```text
Add an advanced code workspace for Python analysis without compromising the web application.

Requirements:
- Monaco or the repository-approved editor with Python syntax, format, run, stop, and clear-output controls.
- Cells or ordered code blocks with persisted source, outputs, status, duration, and dataset-version dependency.
- A per-project isolated execution environment with strict CPU, memory, wall-clock, process, filesystem, and output limits.
- Network disabled by default. Make any network-enabled mode an explicit administrator/user policy.
- Read-only access to immutable inputs and a dedicated writable artifact directory.
- An allowlisted base environment. Package installation must be disabled by default or isolated and explicitly approved.
- Capture tables, text, errors, and supported chart artifacts using structured protocols rather than unsafe HTML.
- Sanitize rendered HTML/SVG and prevent browser script execution.
- Restartable kernels with visible state and reproducibility warnings.
- A “convert actions to notebook/script” export that includes dataset-version references and environment metadata.

Threat-model and test container escape attempts, fork bombs, huge output, infinite loops, filesystem traversal, secret access, malicious HTML, and concurrent-user isolation.

Do not claim production safety solely because Docker is used. Document residual risks and recommended production isolation.
```

## Prompt 9 — Modeling workbench

```text
Implement a guided classical machine-learning workbench built on explicit experiment specifications.

MVP tasks:
- Regression and classification.
- User chooses target, included/excluded features, split strategy, metrics, and seed.
- Detect and block obvious target leakage and identifier misuse, with an override explanation rather than silent removal.
- Support random, stratified, grouped, and time-aware splits where appropriate.
- Establish simple baselines before complex models.
- Start with a small approved model set from scikit-learn; do not build unrestricted AutoML.
- Fit preprocessing only on training folds using pipelines.
- Run experiments as cancellable, resource-limited jobs.

Results:
- Comparable experiment table with dataset version, features, split, model, hyperparameters, metrics, duration, and environment.
- Classification: confusion matrix, precision/recall/F1, ROC-AUC or PR-AUC when valid, class distribution, and threshold analysis.
- Regression: MAE, RMSE, R-squared, actual-versus-predicted, and residual diagnostics.
- Cross-validation distribution rather than only a single score.
- Feature importance and SHAP only when appropriate, with limitations clearly explained.
- Side-by-side comparison of two experiments.
- Persist specifications, metrics, and artifacts; do not serialize unsafe arbitrary Python objects for untrusted loading.

The assistant may recommend models and metrics, but must explain the recommendation from task type, sample size, target distribution, and data structure.

Test leakage prevention, reproducibility, split correctness, metric edge cases, cancellation, and experiment comparison.
```

## Prompt 10 — Reports and project history

```text
Implement a report builder and complete project activity history.

Report blocks can reference saved dataset-profile summaries, issues, charts, transformations, code outputs, experiment comparisons, Markdown commentary, and limitations. References must point to immutable artifact/version IDs so a report does not silently change.

Requirements:
- Drag to reorder, hide, duplicate, and edit report blocks.
- Auto-generate a draft narrative, but label AI-authored interpretation and retain evidence links.
- Include methodology, dataset version, filters, sampling, missing-value handling, model evaluation design, limitations, timestamps, and environment information.
- Export a self-contained HTML report first. Add PDF only if the repository has a reliable render-and-verify path.
- Escape or sanitize all user and model content.
- Add an activity timeline for uploads, profiles, transformations, suggestions, charts, code runs, experiments, exports, failures, and reversions.
- Make runs reproducible from recorded specifications where dependencies still exist.

Acceptance criteria:
- A new user can upload data, profile it, create a chart, apply a transformation, run a baseline model, compare results, and export a truthful report.
- Exported content cannot execute arbitrary scripts.
```

## Prompt 11 — Multi-user accounts, authorization, and quotas

```text
Prepare the locally working application for other users. First document the current trust model and create a migration plan; then implement the approved approach.

Requirements:
- Authentication through the selected trusted provider; do not build password storage casually.
- Every project, dataset version, artifact, job, session, and provider credential has an owner or explicit workspace scope.
- Enforce authorization on the server for every request and job. Client-side hiding is not authorization.
- Use non-guessable identifiers without relying on identifier secrecy for access control.
- Encrypt secrets at rest using the deployment platform's secret system.
- Add user-controlled deletion and retention behavior for datasets, derived files, logs, and sessions.
- Add quotas for storage, upload size, concurrent jobs, execution time, LLM usage, and export size.
- Rate-limit costly and security-sensitive endpoints.
- Prevent cross-user cache keys, file paths, logs, job channels, and agent-session leakage.
- Add an administrator view for aggregate health and quota management without exposing dataset contents.
- Define sharing as a separate feature. Keep projects private by default.
- Add structured audit events for security-relevant actions without storing sensitive payloads.

Create an authorization matrix and automated tests attempting cross-user reads, writes, job subscriptions, artifact downloads, cache access, and session access.

Stop and report any area where the current Pi session model cannot safely support multi-tenancy without upstream isolation work.
```

## Prompt 12 — Production hardening and observability

```text
Perform a production-readiness pass. Begin with a written threat model and failure-mode inventory, then address the highest-priority verified gaps.

Cover:
- Upload and parser abuse, decompression bombs, formula injection, prompt injection, XSS, CSRF, SSRF, path traversal, command injection, container escape, dependency risk, denial of service, and authorization bypass.
- Database migrations, transactions, indexes, connection limits, backup/restore, artifact integrity, and orphan cleanup.
- Job idempotency, retries with backoff, cancellation, dead-letter handling, worker loss, and duplicate delivery.
- Structured logs with redaction, metrics, traces, health/readiness checks, error tracking, and cost/usage dashboards.
- LLM-provider outages, quota exhaustion, malformed responses, model changes, and deterministic non-AI fallbacks.
- Accessibility audit, supported-browser checks, responsive layouts, and realistic large-data performance tests.
- Dependency/license inventory and automated vulnerability checks.
- Privacy notice, acceptable-use controls, data retention, and an honest description of what leaves the deployment.

Add end-to-end tests for the primary user journey and CI gates for formatting, type checking, unit tests, integration tests, security tests, and a production build.

Produce `docs/production-readiness.md` with verified status, evidence, remaining blockers, and rollback procedures. Do not label the application production-ready while critical blockers remain.
```

## Prompt 13 — Deployment

```text
Create a deployment design for this repository and the chosen platform before modifying deployment files.

The design must separate:
- Web frontend/API.
- Persistent relational metadata store.
- Object storage for immutable datasets and artifacts.
- Queue and resource-isolated analytical/code workers.
- Secret management.
- Observability.

Then implement the approved deployment configuration with:
- Reproducible builds and pinned runtime versions.
- Separate development, staging, and production configuration.
- Database migration and rollback procedure.
- Worker autoscaling and hard resource ceilings.
- Private storage with short-lived authorized downloads.
- TLS, secure headers, origin policy, and health checks.
- Backup and restore verification.
- A smoke test that creates a temporary project, ingests a small fixture, profiles it, renders a chart, and deletes the temporary resources safely.

Never commit secrets. Document every required environment variable by name and purpose using placeholders. Stop before any irreversible infrastructure action or public deployment and request explicit approval with a cost and security summary.
```

## Prompt 14 — Final product audit

```text
Audit the finished workbench as a skeptical staff engineer, data scientist, security engineer, and first-time user.

Do not begin by changing code. Produce findings ranked critical, high, medium, and low, each with evidence and affected files or flows.

Verify:
- The complete user journey works without mock data.
- Statistical calculations, transformations, splits, metrics, and chart labels are truthful.
- Side-by-side views remain synchronized and understandable.
- AI suggestions cite evidence and never silently execute actions.
- Dataset versions and reports are reproducible.
- Multi-user authorization cannot be bypassed through IDs, jobs, downloads, sessions, caches, or WebSockets.
- Code execution cannot access the web server, secrets, other users, or unrestricted network/filesystem resources.
- Large files and long jobs fail predictably and recoverably.
- Accessibility and responsive behavior meet the documented target.
- Documentation matches actual commands and behavior.

After I approve the findings, fix them in risk order using one bounded change at a time. Re-run the relevant tests after every fix and finish with a release checklist containing only verified statements.
```

## Recommended working rhythm

For every stage: create a branch, run the prompt, inspect the plan/diff, test the behavior yourself, commit the bounded change, and only then continue. If Pi proposes changing the agent core, ask it to justify why the SDK, RPC, extension, or a separate package cannot support the requirement.
