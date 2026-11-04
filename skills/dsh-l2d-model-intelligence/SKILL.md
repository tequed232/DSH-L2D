---
name: dsh-l2d-model-intelligence
description: Perform end-to-end Live2D model package ingestion, MOC3 structural analysis, hierarchy reconstruction, semantic mapping, behavior analysis, SQLite registration, and DSH-L2D runtime handoff.
---

# DSH-L2D Model Intelligence

## Mission

Provide the shared domain workflow used by the orchestrator and all three specialist workspaces. Transform a Live2D model package into a verifiable structural graph, semantic skeleton, behavior map, and runtime-ready binding registry.

## Core principles

- Original model assets are immutable; all extraction and analysis outputs go to a model-scoped workspace.
- Reuse verified local tools before installing new dependencies.
- Separate source-exact, parser-derived, runtime-observed, heuristic, and human-verified facts.
- Every inferred mapping carries provenance, confidence, and verification status.
- Do not equate Live2D Deformers with conventional 3D bones. Parameters, Keyforms, Deformers, ArtMeshes, masks, and runtime behavior are distinct concepts.
- Never invent parser capabilities, MCP tools, SDK availability, or successful test results.
- Preserve existing DSH-L2D controllers and compatibility.

## Canonical pipeline

### 1. Package ingestion

- Accept a model directory or archive.
- Validate archive paths, symlinks, expansion ratio, file sizes, and file types.
- Compute SHA-256 hashes and create `package_manifest.json`.
- Assign stable `model_id` and `analysis_job_id`.
- Keep source assets read-only.

### 2. Extraction and inventory

Classify and resolve references for:
- `.model3.json`
- `.moc3`
- texture PNGs
- `.physics3.json`
- `.motion3.json`
- `.exp3.json`
- `.pose3.json`
- `.cdi3.json`
- `.userdata3.json`

Generate an inventory with file type, size, hash, reference relationships, missing files, and validation warnings.

### 3. Binary inspection

Use a verified MOC3 parser (for example, a locally verified Rust parser or Python parser implementation) and record exact version/format support. Export normalized IR while preserving source identifiers and indices. Extract only fields actually supported by the parser: parameters, parts, drawables/ArtMeshes, deformers, vertices, indices, masks, draw order, and available relationships.

Do not guess undocumented binary offsets. Report unsupported format sections as unknown.

### 4. Hierarchy reconstruction

Build a graph of nodes and relationships. Every edge records relationship type, evidence reference, provenance, confidence, and parser version. Keep explicit hierarchy separate from inferred grouping. Do not call a Deformer a bone unless the source/runtime semantics justify that exact term.

### 5. Multimodal semantic analysis

Combine:
- texture atlas pixels
- UV coordinates
- mesh geometry
- draw order and masking
- structural IDs and hierarchy
- runtime probe evidence where available

Classify head, face, eye, iris, mouth, hair, body, limbs, clothing, and accessories only with traceable evidence. Track coordinate/view conventions and ambiguity. Low-confidence mappings require review.

### 6. Parameter, motion, and physics analysis

Extract parameter IDs, bounds, defaults, keyforms, motion curves, fades, groups, events, physics inputs/outputs, and links where supported. Build a behavior map from action/motion/physics sources to parameter bindings and semantic targets.

For dynamic probing, use a verified runtime, baseline snapshots, one-parameter-at-a-time perturbations, bounded values, state diffs, and reset after each probe. If runtime or license is unavailable, provide static-only analysis and mark dynamic verification blocked.

### 7. SQLite registration

Use `database/l2d_models.sqlite3` unless repository architecture specifies another canonical database. Suggested logical entities:
- models
- source_files
- parser_runs
- nodes
- edges
- parameters
- parameter_bindings
- semantic_mappings
- motions
- physics_rigs
- behavior_maps
- action_chains
- runtime_tests
- analysis_jobs
- evidence_artifacts

Use foreign keys, indexes, transactions, schema migrations, and idempotent upserts. Store large binary assets outside SQLite and reference them by content hash/path. Never overwrite source facts with AI-inferred values.

### 8. Runtime integration

Map semantic roles to verified parameter bindings, then to the existing DSH-L2D action-chain/controller interfaces. Reuse the existing limb ownership controller. Add arbitration across chat intent, autonomous animation, motion playback, physics, and user control. Define priority, lease, preemption, cancellation, timeout, and rollback. Keep model parsing independent from runtime execution.

### 9. QA and report

Validate package integrity, parser output, graph referential integrity, mapping evidence, parameter ranges, database consistency, runtime behavior, arbitration, cancellation, and rollback. Produce machine-readable reports and a concise human-readable summary.

## Suggested service boundaries

- `services/package-ingestor/`
- `services/moc3-parser/`
- `services/hierarchy-engine/`
- `services/semantic-analyzer/`
- `services/behavior-analyzer/`
- `services/runtime-bridge/`
- `services/l2d-mcp-server/`

Treat these as architectural suggestions; inspect the repository before creating or moving code.

## MCP capability groups

Package inspector: `l2d_import_package`, `l2d_extract_package`, `l2d_validate_package`, `l2d_get_asset_inventory`.

Structure inspector: `l2d_inspect_model`, `l2d_get_hierarchy`, `l2d_get_node_detail`, `l2d_get_deformers`, `l2d_get_artmeshes`, `l2d_get_parameters`, `l2d_get_parameter_bindings`.

Semantic analyzer: `l2d_analyze_texture`, `l2d_map_uv_regions`, `l2d_classify_nodes`, `l2d_build_semantic_skeleton`, `l2d_review_mapping`.

Behavior analyzer: `l2d_analyze_motion`, `l2d_analyze_physics`, `l2d_probe_parameter`, `l2d_compare_model_state`, `l2d_build_behavior_map`.

Runtime controller: `l2d_register_action_chain`, `l2d_validate_action_chain`, `l2d_execute_action_chain`, `l2d_get_runtime_state`, `l2d_rollback_action`.

These are desired tool contracts. Discover the actual MCP server, tool schemas, and transport before use. Do not fabricate tools.

## Permissions

- Inspector: read-only.
- Analyzer: write analysis artifacts and database records only.
- Runtime controller: explicit authorization for model-affecting actions.
- No arbitrary filesystem access through MCP.
- No unverified binary execution or license bypass.

## Toolchain discovery and installation

Inspect OS/architecture, CPU/RAM/GPU/disk, Python, Node, Rust/Cargo, CMake, Git, SQLite, image libraries, Live2D SDK/Core/Framework/Editor, parser tools, MCP configuration, and existing DSH-L2D services.

Use inspect → reuse → plan → install → verify → register. Prefer project-local dependencies, pinned versions, trusted sources, checksums/signatures, and lockfiles. Do not blindly install CUDA. Proprietary SDK/editor installation, license acceptance, paid services, global system changes, port exposure, replacing existing SDKs, and large downloads require user approval.

Record toolchain metadata in `config/l2d-toolchain.json`: name, version, path, source, checksum, installation scope, verification status, smoke-test result, and timestamp.

After installation, verify binary/library presence, version output, smoke test, and workflow integration. A successful package-manager exit code alone is not proof of readiness.

## Error recovery

- Preserve original assets and last known-good runtime state.
- Record failed stage, correlation ID, logs, versions, and reproducible input hashes.
- Retry only transient failures with bounded retries.
- Restart only plugin-owned services when authorized.
- Never terminate unrelated processes.
- Roll back partial runtime changes and leave analysis artifacts inspectable.
