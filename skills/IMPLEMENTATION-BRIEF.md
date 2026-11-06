# Coding Agent Implementation Brief — Skill Bootstrap & Startup Gate

> This is an implementation task for the repository coding agent. The skill specifications are the product contract; implement against the actual repository and host APIs. Do not assume APIs exist.

## Objective

Implement the plugin lifecycle that installs/enables the complete skill suite, bootstraps three persistent worker conversations, injects role prompts, audits all skills/prompts/plugin dependencies on every startup, and blocks Live2D model loading until preflight is verified.

## Mandatory first step: repository and host audit

Before editing:
1. Inspect the complete repository tree, current plugin manifest/installer, runtime entrypoints, model-loading path, conversation/workspace integration, prompt storage, MCP client/server configuration, tests, and release packaging.
2. Identify the actual host platform(s) and their documented APIs for creating conversations/workspaces and setting system prompts. Confirm authentication and permission boundaries.
3. Trace current model loading and identify the earliest safe interception point for a preflight gate.
4. Identify existing dependency/toolchain discovery code and reuse it. Do not create a parallel registry or duplicate service manager.
5. Produce an architecture note and implementation plan with exact files/interfaces before making broad changes.

## Functional requirements

### A. Skill package manager
- Read `skills/manifest.yaml` as the authoritative registry.
- Validate every required Skill file, frontmatter, unique ID, semver, references, prompt file, JSON schema, and compatibility declaration.
- Register/enable all required skills during plugin installation and update.
- Make installation idempotent; repeated runs must not create duplicates.
- Track installed version, file hash, registration status, last validation time, and failure details.
- Do not overwrite user-customized skill or prompt content without a migration diff and approval.
- Fail installation clearly if a required skill is malformed or unavailable.

### B. Three-workspace bootstrap
Implement an adapter abstraction for the host's conversation/workspace API. Required operations:
- list/find by stable ID
- create workspace with stable ID and title
- set title
- inject system prompt and metadata (skill ID, prompt version, SHA-256)
- read back title and prompt metadata/hash
- send a health-check task and receive a correlated response
- dispatch task envelope and retrieve result envelope

Create/reconcile exactly the manifest workspaces:
1. `L2D · 01 结构解析`
2. `L2D · 02 语义与行为`
3. `L2D · 03 运行时与验收`

Use stable IDs from the manifest, not titles, to avoid duplicates. Verify writes by reading back state. If the host has no supported API, implement the closest supported workspace/session mechanism and explicitly report unsupported automation. Never simulate successful creation or prompt injection.

### C. Prompt lifecycle
- Load prompts from the manifest paths.
- Inject them only into their corresponding worker workspace.
- Store prompt version and SHA-256.
- On startup, compare expected and actual prompt hashes.
- Restore only missing default prompts when the workspace is known to be uncustomized.
- For changed/custom prompts, preserve content, generate a diff, and require approval before migration.
- Detect truncated, empty, mismatched, or role-contaminated prompts.

### D. Startup preflight before model load
Add a mandatory startup state machine:

`STARTING → SKILL_AUDIT → WORKSPACE_AUDIT → PROMPT_AUDIT → TOOLCHAIN_AUDIT → MCP_HEALTH → PREFLIGHT_DECISION → MODEL_LOAD`

No model load call may bypass this state machine.

Preflight checks:
- all required skills are present, enabled, parseable, compatible, and hash-verified
- all three worker workspaces exist and are reachable
- all three titles, skill bindings, prompt versions, and prompt hashes match expected state
- workspace dispatch health checks succeed
- MCP servers are configured, connected, and expose valid schemas for required capabilities
- required local SDKs/parsers/runtime dependencies exist and pass version/smoke checks
- source model package is valid and has not been modified
- plugin services and database migrations are healthy

Decision values:
- `PASS`
- `PASS_WITH_WARNINGS` (only for optional/non-blocking components)
- `BLOCKED`

Blocking failures must prevent model load and return machine-readable error codes, evidence, and remediation. Do not allow a UI-only bypass.

### E. Toolchain discovery and management
- Detect OS, architecture, CPU, RAM, GPU APIs/drivers, disk space, Python, Node, Rust/Cargo, CMake, Git, SQLite, image processing libraries, Live2D SDK/Core/Framework/Editor, MOC3 parsers, MCP servers, and DSH-L2D runtime components.
- Detect existing installations before downloading anything.
- Prefer project-local dependencies and pinned versions.
- Use trusted upstream sources and verify checksums/signatures when available.
- Never run unverified binaries or remote shell scripts.
- Do not install CUDA merely because a GPU is present.
- Require approval for proprietary SDK/editor licenses, paid services, global/system changes, port exposure, replacement of existing SDKs, and large downloads.
- Record tool name, version, source, path, hash, install scope, verification status, smoke-test result, and timestamp in the canonical toolchain registry.
- A package-manager exit code is not sufficient; run a smoke test and an integration check.

### F. Runtime task dispatch
- Use the task/result schemas under `skills/contracts/`.
- Include task ID, analysis job ID, model ID, source hashes, objective, scope, evidence references, dependencies, and acceptance criteria.
- Route work to the correct worker according to the orchestrator Skill.
- Correlate results and reject stale results with mismatched source hashes.
- Do not pass secrets or unnecessary binary content in prompts.

### G. Observability and recovery
- Persist bootstrap state, skill hashes, workspace IDs, prompt hashes, toolchain status, last preflight result, and event timestamps.
- Use correlation IDs for every lifecycle and task event.
- Retry transient failures with bounded retries.
- Avoid duplicate workspace creation during retries.
- Restart only plugin-owned services and only when authorized.
- Preserve last-known-good model/runtime state and support rollback.

## Security and privacy

- No arbitrary filesystem MCP tool.
- No credentials/tokens in logs or prompts.
- No silent prompt replacement.
- No unapproved live model control.
- No license bypass or unverified binary execution.
- Keep original model assets read-only.
- Validate all paths and archive extraction destinations.

## Testing requirements

Add unit, integration, and failure-path tests for:
- valid/invalid manifest and Skill frontmatter
- missing/duplicate/stale skill registrations
- workspace creation idempotency
- title and prompt injection read-back verification
- prompt hash mismatch and custom-prompt preservation
- missing workspace API / unavailable worker
- startup gate blocks model loading on each required failure
- optional dependency warning does not incorrectly block
- MCP unavailable/schema mismatch
- tool already installed vs missing dependency
- checksum failure and smoke-test failure
- stale task result with wrong source hash
- retries without duplicate workspaces
- cancellation and recovery

## Deliverables

1. Implemented installer/registrar and manifest validator.
2. Host workspace adapter plus a capability report for each supported host.
3. Three-workspace bootstrap and prompt injection/reconciliation.
4. Startup preflight state machine integrated into the real model-load path.
5. Toolchain discovery/verification and registry integration.
6. Structured health/preflight report.
7. Automated tests and CI coverage.
8. Documentation describing supported host APIs, limitations, permissions, and manual fallback.
9. A separate PR if implementation scope is too large; do not collapse unreviewed runtime changes into the skill-spec PR.

## Definition of Done

- Fresh installation registers all required Skills and creates/reconciles exactly three worker conversations on a supported host.
- Each conversation has the exact title, stable ID, correct role prompt, and verified prompt hash.
- Restarting the plugin does not create duplicates or silently overwrite user customizations.
- Every plugin startup audits skills, prompts, workspaces, MCP, SDKs, and services before loading a model.
- A required failure blocks model loading with a precise diagnostic.
- A successful preflight is backed by actual read-back and smoke-test evidence.
- Tests cover normal, failure, retry, and recovery paths.
