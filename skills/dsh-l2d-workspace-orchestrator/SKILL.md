---
name: dsh-l2d-workspace-orchestrator
description: Automatically bootstrap and maintain the DSH-L2D three-workspace agent framework; audit skills, prompts, tools, MCP services and SDKs on installation and every startup; dispatch work and gate model loading on verified readiness.
---

# DSH-L2D Workspace Orchestrator

## Mission

Act as the single control plane for the DSH-L2D plugin. Establish a repeatable three-worker workspace framework before loading any Live2D model. Own skill registration, prompt integrity, workspace creation/reconciliation, task routing, startup preflight, dependency discovery, and final acceptance.

Do not perform every specialist task in the coordinator conversation. Delegate specialist work to the three named workspaces and preserve a common source of truth.

## Non-negotiable lifecycle

**Install → Skill audit → Workspace bootstrap → Prompt injection verification → Startup preflight → Model-load gate → Model load → Task dispatch → Cross-check → Report.**

Never load a model before the preflight gate. Never claim a workspace, skill, service, SDK, or dependency is ready based only on a configured name or a successful install command.

## 1. Install-time bootstrap

When the plugin is installed or enabled:

1. Read `skills/manifest.yaml`; validate schema version, suite compatibility, unique IDs, semver, file paths, required frontmatter, and prompt references.
2. Register/enable every required skill in the manifest. Registration must be idempotent: rerunning installation must update or reconcile, not duplicate.
3. Resolve the host's supported conversation/workspace API through a dedicated adapter. Required adapter capabilities:
   - `list_workspaces()`
   - `create_workspace(title, stable_id)`
   - `get_workspace(stable_id)`
   - `set_workspace_title(id, title)`
   - `set_workspace_system_prompt(id, prompt, prompt_version, prompt_hash)`
   - `get_workspace_prompt_state(id)`
   - `send_task(id, task_envelope)`
   - `get_task_result(id, task_id)`
   - `health_check()`
4. Create or reconcile exactly these three persistent worker conversations:
   - `L2D · 01 结构解析`
   - `L2D · 02 语义与行为`
   - `L2D · 03 运行时与验收`
5. Inject the corresponding prompt files from `skills/prompts/`. Each prompt must include role boundaries, tool permissions, expected inputs/outputs, evidence requirements, and escalation rules.
6. Verify title, stable ID, prompt version, and prompt hash by reading state back from the host. A successful write response alone is insufficient.
7. Persist workspace IDs and hashes in plugin-owned state. Do not use conversation titles as unique identifiers.
8. Emit an install report. If the host lacks workspace APIs, mark `WORKSPACE_ADAPTER_UNAVAILABLE`; do not fabricate success. Continue validating all other components.

## 2. Three-worker contract

### Worker 1 — Structure Inspector

Owns package ingestion, archive safety, asset inventory, MOC3 parsing, source-fact extraction, Parts/ArtMeshes/Deformers/Parameters, hierarchy reconstruction, and structural evidence. It must not infer visual semantics from IDs alone.

### Worker 2 — Semantic & Behavior Analyst

Owns texture/atlas inspection, UV and geometry-assisted semantic mapping, visual labels, Motion3/Physics3 analysis, parameter probing, behavior maps, and confidence/provenance. It must not modify original model assets.

### Worker 3 — Runtime Integrator & QA

Owns runtime capability discovery, mapping semantic controls to verified parameter bindings, action-chain integration, limb ownership arbitration, regression tests, rollback design, and independent acceptance. It must preserve existing DSH-L2D controllers and compatibility.

## 3. Shared domain rules

All three specialist Skills follow the same domain constraints:

- Keep original model assets immutable; write extracted and analyzed artifacts to a model-scoped workspace.
- Distinguish source-exact facts, parser-derived facts, runtime-observed facts, heuristic associations, and human-verified conclusions.
- Every inferred mapping must carry provenance, confidence, evidence references, and verification status.
- Do not equate Live2D Deformers with conventional 3D bones. Parameters, Keyforms, Deformers, ArtMeshes, masks, and runtime behavior are distinct concepts.
- Never invent parser capabilities, MCP tools, SDK availability, or successful test results.
- Preserve existing DSH-L2D controllers and compatibility; inspect before extending or replacing anything.

The end-to-end workflow is owned collectively by the three specialists:

1. package ingestion, source hashing, and safe extraction — Worker 1
2. asset inventory, MOC3 inspection, and hierarchy reconstruction — Worker 1
3. texture/UV/geometry semantic analysis — Worker 2
4. parameter, motion, and physics analysis — Workers 1 and 2
5. SQLite registration with provenance and idempotent migrations — owning worker for each artifact
6. runtime mapping, action-chain integration, and ownership arbitration — Worker 3
7. regression testing and independent QA — Worker 3

Use `database/l2d_models.sqlite3` as the default database only if repository inspection confirms that no existing canonical database should be reused. Keep large binary assets outside SQLite and reference them by content hash/path.

## 4. Startup audit — every plugin launch

Run a read-only audit before loading the model:

### A. Skill integrity
- Read manifest and all required SKILL.md files.
- Validate frontmatter, names, descriptions, version compatibility, paths, encoding, non-empty body, and duplicate IDs.
- Validate prompt files exist and map one-to-one to the three workspace IDs.
- Compare installed skill versions and content hashes with the manifest.
- Detect missing, stale, malformed, disabled, or partially registered skills.
- Confirm all skills are available to the current agent runtime, not merely present on disk.

### B. Prompt integrity
- Verify each worker has the expected title, stable workspace ID, prompt version, and SHA-256 prompt hash.
- Detect truncation, failed injection, accidental role crossover, and custom edits.
- If the prompt is missing and the workspace is uncustomized, restore the manifest version.
- If a prompt differs from the expected hash, preserve the current prompt, create a diff, and ask for migration approval. Never overwrite user customizations silently.

### C. Workspace integrity
- Confirm all three workspaces exist, are reachable, and are bound to the correct skill.
- Confirm no duplicate workspace was created for the same stable ID.
- Verify the dispatch adapter can send a harmless health-check task and receive a correlated response.
- If a worker is unavailable, block tasks that depend on it and report the exact failure.

### D. Toolchain and service integrity
- Inspect MCP configuration, server registration, transport, tool schemas, connection state, and health checks.
- Inspect Python, Node, Rust/Cargo, CMake, Git, SQLite, image tooling, Live2D SDK/Core/Framework/Editor, parser binaries, and the existing DSH-L2D runtime.
- Inspect CPU architecture, RAM, GPU APIs/drivers, disk capacity, and project-local environment.
- Inspect process, port, endpoint, logs, and service health only where relevant.
- Reuse verified tools before installing alternatives. Never install CUDA solely because a GPU exists.

### E. Model-load gate
Return one of:
- `PASS`: all required skills, prompts, workspaces, adapters, and model prerequisites verified.
- `PASS_WITH_WARNINGS`: non-blocking optional component missing; model can load safely.
- `BLOCKED`: any required skill/prompt/workspace adapter is missing, prompt injection is unverified, parser/runtime prerequisites are unsafe, or asset integrity fails.

Only PASS and explicitly permitted PASS_WITH_WARNINGS allow model loading. A blocked state must include machine-readable codes, evidence, remediation, and whether user approval is required.

## 5. Dependency management and safe repair

Use **inspect → reuse → plan → install → verify → register**.

- Prefer project-local virtual environments and pinned versions.
- Use official upstream releases and package registries; verify checksums/signatures when published.
- Record name, version, source, path, hash, install time, verification result, and compatibility in `config/l2d-toolchain.json`.
- After installation, verify executable/library presence, version, smoke test, and integration test.
- Do not run unverified binaries or arbitrary shell scripts from downloads.
- Do not expose secrets in logs.
- Do not perform global installs, accept proprietary licenses, incur paid costs, change system security settings, open ports, replace existing SDKs, or download very large assets without approval.
- Live2D proprietary SDK/Editor licensing and account requirements must be respected. Never bypass licensing or authentication.

## 6. Task routing

Every task receives a shared envelope (see `skills/contracts/task-envelope.schema.json`) containing:
- `task_id`, `analysis_job_id`, `model_id`
- immutable source package hashes and model version
- task objective, scope, constraints, expected artifacts
- upstream evidence references and dependency task IDs
- required tools/capabilities and deadline/priority where supported

Routing:
- package/MOC3/hierarchy/parameter facts → Worker 1
- texture/UV/semantic mapping/motion/physics/probing → Worker 2
- runtime mapping/action chains/ownership/regression → Worker 3
- cross-cutting tasks → create linked subtasks and dispatch to the minimum necessary workers.

Do not send a worker only a vague natural-language request. Attach the relevant context, paths/IDs, acceptance criteria, and output schema. Avoid copying large binary assets into prompts; pass stable file references.

## 7. Result reconciliation

Require each worker to return:
- status: `completed | partial | blocked | failed`
- summary and findings
- artifacts and database record IDs
- evidence references, source hashes, tool versions
- confidence and provenance for inferred claims
- tests run and results
- unresolved questions and handoff targets

Reject unsupported claims. Distinguish source-exact facts, parser-derived facts, runtime-observed facts, and AI-inferred hypotheses. For disputed mappings, request evidence from the owning worker and an independent QA check from Worker 3.

## 8. State and observability

Maintain a plugin-owned bootstrap state containing:
- manifest version/hash
- installed skill versions/hashes
- workspace stable IDs, host IDs, title, prompt version/hash
- adapter capability/version and last health check
- toolchain registry hash and verification timestamps
- last preflight result and blocking codes

Log lifecycle events with correlation IDs. Redact credentials, tokens, private user data, and proprietary asset contents.

## 9. Recovery

- Retry transient workspace API failures with bounded backoff.
- Do not create a second workspace until lookup by stable ID confirms the original is absent.
- On prompt injection failure, read back state, retry once, then block dependent tasks.
- On skill mismatch, report expected/actual versions and propose a diff; do not delete unknown user files.
- On service failure, inspect logs/process/ports/dependencies; restart only plugin-owned services and only when policy permits.
- Preserve the last known-good model and runtime state; rollback partial runtime changes.

## 10. Final report

Provide:
1. bootstrap/startup status
2. three workspace IDs, titles, skill bindings, prompt hashes
3. skill audit table with expected/actual version and status
4. MCP/toolchain/service status
5. model-load gate and blocking reasons
6. dispatched tasks and worker results
7. artifacts, tests, unresolved risks, next actions

Never report success for an operation that the host adapter did not confirm.
