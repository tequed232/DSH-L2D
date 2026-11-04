---
name: dsh-l2d-model-intelligence
description: Inspect, reverse-engineer, index, and validate Live2D Cubism model packages for DSH-L2D. Use when importing a model, inspecting MOC3 structure, reconstructing parameter/deformer/ArtMesh relationships, building semantic skeletons, probing motion or physics, or preparing a model capability profile for runtime integration.
version: 2.1.0
---

# DSH-L2D Model Intelligence

## Mission

Turn a user-supplied Live2D model package into a traceable, queryable, runtime-safe model capability profile. Discover and reuse the existing DSH-L2D codebase, tools, SDKs, MCP servers, databases, and controllers before adding anything.

This skill owns **model-package intelligence**. It does not own workspace conversation creation, plugin installation lifecycle, or global skill orchestration; those belong to the plugin bootstrap/orchestrator skills.

## Non-negotiable principles

1. **Inspect before installing; reuse before downloading.**
2. Keep source assets immutable. Never rewrite, optimize, re-encode, or patch the original model package.
3. Separate facts from inferences. Every extracted item must carry provenance and verification status.
4. Never claim a hierarchy, bone, binding, or capability exists unless supported by parser output or runtime evidence.
5. Live2D is not a conventional 3D skeletal rig. Treat Parameters, Keyforms, Deformers, ArtMeshes, Parts, masks, and draw order as distinct structures.
6. Never let an inferred semantic label directly control runtime parameters. Require a validated binding and capability check.
7. Preserve existing DSH-L2D action-chain, parameter mixer, ownership, and arbitration contracts. Extend through adapters; do not replace them.
8. Ask before proprietary SDK/editor installation, license acceptance, paid services, global system changes, public network exposure, persistent background services, or destructive actions.
9. Do not expose arbitrary filesystem, shell, or network access as MCP tools.
10. A successful install command is not proof of a working dependency. Verify executable, version, smoke test, and integration.

## Entry conditions

Accept a model directory or archive supplied by the user or explicitly selected from a configured model directory. If no model is specified, ask for its path. Never recursively scan unrelated home directories or upload model assets to external services without explicit authorization.

Create a stable `model_id` and `analysis_job_id`. Calculate SHA-256 hashes for the original package and relevant source files. Record file size, relative path, detected format, and timestamp.

## Phase 0 — Repository and environment reconnaissance

Before changing code or installing dependencies:

- Inspect repository root, package manager, lockfiles, workspace configuration, existing docs, tests, and current branch/worktree state.
- Locate existing model importers, MOC3 parsers, capability scanners, renderer adapters, MCP tools, model registries, SQLite schemas, acceptance tests, and runtime controllers.
- Inspect current DSH-L2D APIs and contracts, especially parameter mixing, action chains, ownership arbitration, cancellation, runtime state, and rollback.
- Detect OS, architecture, CPU, RAM, GPU, available disk, Python, Node.js, pnpm/npm, Rust/Cargo, CMake, Git, and relevant package managers.
- Detect installed Cubism SDK/Core/Framework/Editor versions and paths, but do not assume they are licensed or compatible.
- Inspect MCP configuration and discover registered servers, tool names, transport, endpoint, health status, and schemas using supported host interfaces.
- Check local service processes, loopback ports, health endpoints, and logs without killing or restarting unrelated processes.

Write a machine-readable environment report and toolchain registry. Mark each dependency as `present_verified`, `present_unverified`, `missing`, `incompatible`, or `license_gated`.

Do not install a second copy of an existing compatible tool. If an open-source project-local dependency is missing, install it in an isolated project environment with a pinned version and lockfile. Verify its provenance and checksum where available. Do not download unverified binaries. Do not install CUDA merely because a GPU is present.

## Phase 1 — Package ingestion and safety

1. Accept ZIP or directory input.
2. Reject path traversal, absolute archive paths, symlinks escaping the extraction root, suspicious expansion ratios, and oversized archives.
3. Extract into a dedicated per-model workspace; never extract over an existing directory.
4. Preserve the original archive and source files read-only.
5. Inventory common assets:
   - `.model3.json`, `.moc3`
   - textures such as `.png`
   - `.physics3.json`, `.motion3.json`, `.exp3.json`
   - `.pose3.json`, `.cdi3.json`, `.userdata3.json`
   - audio, thumbnails, and other referenced resources
6. Resolve model-relative paths safely and report missing or dangling references.
7. Produce `package_manifest.json`, `asset_inventory.json`, and a validation report.

Never assume every package contains every file type.

## Phase 2 — Binary inspection

Prefer an already-installed, tested parser. Candidate research implementations include:

- LIVE2D-MOC3: https://github.com/loliRuriruri/LIVE2D-MOC3
- py-moc3: https://github.com/Ludentes/py-moc3

Treat these as candidate tools, not guaranteed compatible dependencies. Inspect current README, license, release state, supported MOC3 versions, and tests before adopting them.

Use a parser adapter that emits a versioned intermediate representation (IR). Extract only fields the parser can reliably decode, such as:

- parameters and their ranges/defaults
- parts and drawable references
- ArtMeshes, IDs, draw order, masks, vertices, UVs, indices, and material metadata where supported
- deformer types, IDs, parent-child links, and target relationships where supported
- keyform / parameter binding references where supported

For every field record `source_file`, `source_pointer_or_offset`, `parser_name`, `parser_version`, `confidence`, and `verification_status`. Unknown or unsupported binary fields must remain unknown; do not fabricate decoded values.

## Phase 3 — Hierarchy reconstruction

Build a directed graph with typed edges. Keep separate node classes for:

- Model
- Parameter
- Part
- Deformer
- ArtMesh
- Texture
- Motion
- Expression
- Physics group
- Mask / drawable relationship

Use edge types such as `contains`, `deforms`, `drives`, `uses_texture`, `masks`, `references`, and `belongs_to_part`.

Distinguish three evidence levels:

- `source_exact`: explicitly present in a source file or parser output.
- `parser_derived`: deterministically reconstructed from decoded structures.
- `inferred`: semantic or visual inference that requires review.

Do not flatten a deformer hierarchy into a fake bone skeleton. Export both the raw graph and a readable hierarchy view.

## Phase 4 — Multimodal semantic analysis

Combine texture atlases, UV coordinates, mesh geometry, draw order, IDs, and hierarchy evidence to propose semantic labels such as head, face, eye, iris, pupil, eyebrow, mouth, hair-front, hair-back, torso, arm, hand, leg, accessory, and shadow.

Rules:

- A texture region alone does not prove which ArtMesh uses it.
- A mesh name alone does not prove its visual meaning.
- Use UV-to-atlas mapping and geometry evidence where available.
- Store each proposal with confidence, evidence, and review state.
- Low-confidence or ambiguous mappings must be marked `needs_review`.
- Do not call a semantic label a bone or joint unless the model actually contains a corresponding structure.

Generate a semantic skeleton as a **model-specific semantic control map**, not as a claim that the model has a conventional skeletal rig.

## Phase 5 — Parameter, motion, and physics analysis

Inspect Motion3, Expression, Physics3, Pose, and UserData resources when present. Build a parameter catalog containing IDs, names, ranges, defaults, known keyforms, source motions, and linked drawable/deformer relationships.

Dynamic probing must run only in an isolated test scene or explicitly authorized runtime session:

1. Capture baseline state.
2. Change one parameter at a time within declared bounds.
3. Capture state diffs and rendered observations.
4. Restore baseline in a `finally`/cleanup path.
5. Record test inputs, outputs, runtime version, model hash, and failures.

Never probe a live user-controlled avatar without authorization. Never leave test parameters applied after a probe.

Produce a behavior map that distinguishes directly supported behavior, approximations, unsupported behavior, and unknown behavior.

## Phase 6 — SQLite registration

Reuse the repository's existing database and migration system. Do not create a parallel database if an established registry already exists.

If no suitable schema exists, propose and implement a versioned schema with at least:

- `models`
- `source_files`
- `assets`
- `nodes`
- `edges`
- `parameters`
- `parameter_bindings`
- `semantic_labels`
- `motions`
- `physics_groups`
- `analysis_jobs`
- `probe_runs`
- `capability_profiles`
- `validation_findings`

Use foreign keys, indexes, migrations, transactions, and stable IDs. Store source hashes and parser/schema versions. Keep inferred labels separate from parser facts. Support re-analysis without duplicating records.

## Phase 7 — Runtime integration

Map semantic intents to existing DSH-L2D contracts:

`semantic intent → capability resolution → validated parameter binding → action chain → parameter mixer / ownership arbitration → renderer`

Before integration:

- Inspect the actual controller interfaces and current runtime call graph.
- Confirm every write path passes through the existing ownership/priority arbitration.
- Define parameter ownership, priority, cancellation, timeout, release, and rollback behavior.
- Do not allow multiple action sources to write the same parameter concurrently without arbitration.
- Unknown capabilities must safely degrade or be rejected.
- Keep model-specific mappings in an adapter/profile, not in the generic controller.
- Add contract tests and a real-model acceptance test where possible.

Never bypass or rewrite an existing limb ownership controller merely to make a demo work.

## MCP interface

Expose narrow, typed tools. Reuse existing tool naming and schema conventions if already present.

Suggested read-only tools:

- `l2d_list_models`
- `l2d_get_asset_inventory`
- `l2d_validate_package`
- `l2d_inspect_model`
- `l2d_get_hierarchy`
- `l2d_get_node_detail`
- `l2d_get_deformers`
- `l2d_get_artmeshes`
- `l2d_get_parameters`
- `l2d_get_parameter_bindings`
- `l2d_get_capability_profile`

Suggested analysis tools:

- `l2d_import_package`
- `l2d_analyze_texture`
- `l2d_build_semantic_skeleton`
- `l2d_review_mapping`
- `l2d_analyze_motion`
- `l2d_analyze_physics`
- `l2d_probe_parameter`
- `l2d_build_behavior_map`

Runtime-changing tools must remain separate, explicitly permissioned, and use the existing runtime bridge. Do not expose arbitrary paths, shell execution, unrestricted file reads, or generic HTTP proxy tools.

## Error handling and recovery

- Preserve the original source package and all prior successful analysis outputs.
- Use temporary output plus atomic rename for generated artifacts.
- Make ingestion and analysis idempotent by model hash and analysis version.
- On parser failure, retain the manifest and report unsupported fields rather than aborting all inspection.
- On service failure, inspect logs, process state, ports, environment, and dependency health first.
- Restart only a service owned by this project and only when authorized by the host policy.
- Never terminate unrelated processes or silently alter global configuration.

## Required outputs

For each completed model analysis, provide:

1. Model identity, source hash, and package manifest.
2. Asset inventory and missing-reference report.
3. Parser/toolchain versions and environment report.
4. Raw structure graph and readable hierarchy.
5. Parameter catalog and binding evidence.
6. Semantic control map with confidence and review status.
7. Motion/physics behavior map.
8. SQLite registration/migration result.
9. Runtime adapter proposal and compatibility findings.
10. Test results, unsupported areas, and next actions.

## Definition of Done

A model is not marked ready merely because it loads. Completion requires:

- package integrity and path validation passed;
- source hashes and inventory recorded;
- parser output versioned and evidence-backed;
- hierarchy graph has no invalid references;
- semantic proposals carry confidence and provenance;
- database constraints and idempotency tests pass;
- runtime mappings use validated capabilities;
- all parameter writes pass through the existing arbitration path;
- probe state is restored;
- read-only MCP inspection works;
- limitations and unverified areas are explicitly reported.

Use the status `analyzed` for structurally inspected models and `runtime_verified` only after real runtime acceptance.
