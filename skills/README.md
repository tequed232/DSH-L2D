# DSH-L2D Agent Skills

This directory defines the **install-time and startup-time skill framework** for the DSH-L2D plugin.

## Skill topology

| Skill | Role | Workspace |
|---|---|---|
| `dsh-l2d-workspace-orchestrator` | Bootstrap, audit, dispatch, lifecycle, and model-load gate | Coordinator / main conversation |
| `l2d-structure-inspector` | Package ingestion, MOC3 inspection, hierarchy and parameter facts | Workspace 1 — Structure |
| `l2d-semantic-behavior` | Texture/UV semantics, motion/physics analysis, parameter probing | Workspace 2 — Semantics & Behavior |
| `l2d-runtime-integration` | Runtime mapping, action chains, ownership arbitration, regression QA | Workspace 3 — Runtime & QA |
| `dsh-l2d-model-intelligence` | Shared end-to-end model analysis workflow and domain reference | Shared capability; invoked by the orchestrator and workers |

The three worker conversations are persistent workspaces, not three independent model sessions that may silently drift. The orchestrator owns their creation, naming, prompt injection, dispatch, and health checks.

## Required lifecycle

1. **Install:** register all skills and their versions; validate required files, frontmatter, prompt templates, tool adapters, and dependency declarations. Do not load the target model yet.
2. **Bootstrap:** create or reconcile the three worker workspaces; assign stable IDs; set the exact titles and role prompts; verify each prompt was accepted and persisted.
3. **Startup:** run a read-only audit of skills, prompts, workspace bindings, MCP servers, SDKs, services, and toolchain registry. Repair only safe, project-local drift automatically.
4. **Load gate:** load the Live2D model only after the preflight report is PASS or PASS_WITH_WARNINGS with no blocking failures.
5. **Dispatch:** send each task to the owning workspace with a shared task envelope and immutable model/source identifiers.
6. **Reconcile:** collect structured results, resolve conflicts, require evidence and independent QA, then publish the final status.

## Important capability boundary

A Skill file cannot itself create ChatGPT/WorkBuddy conversations, inject prompts into an external UI, install a plugin, or load a model. The plugin/runtime must implement the adapter operations specified in the orchestrator skill. If the host exposes no conversation-management API, report the missing capability and use its supported workspace/session mechanism; never pretend that a chat was created or a prompt was injected.

## Versioning

- Each skill has independent semver.
- `skills/manifest.yaml` is the source of truth for required skills, versions, roles, workspace IDs/titles, prompt paths, dependencies, and compatibility.
- Skill changes that affect interfaces must update the manifest and contract docs in the same PR.
- Never silently replace a user's customized worker prompt. Compare hashes and offer a migration/diff; preserve custom sections.

## Review policy

This PR introduces the skill specifications and contracts. The plugin-side workspace adapter, installer, startup auditor, and model-load gate are implementation work for the coding agent and should be proposed in follow-up PRs after repository inspection and host API verification.
