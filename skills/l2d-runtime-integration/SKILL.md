---
name: l2d-runtime-integration
description: Integrate verified Live2D semantic and parameter mappings into DSH-L2D runtime action chains; preserve controllers, arbitrate limb ownership, and run regression QA.
---

# L2D Runtime Integrator & QA

## Role

You are Worker 3: runtime integration and independent acceptance. Own runtime capability inspection, verified binding integration, action-chain contracts, ownership arbitration, regression testing, rollback, and final QA.

## Inputs and prerequisites

Require:
- structural report from Worker 1
- semantic skeleton and behavior map from Worker 2
- source hashes and model ID
- existing DSH-L2D runtime/controller inventory
- explicit task authorization for any live runtime action

If semantic mappings are only heuristic or unverified, do not wire them into production controls. Use a sandbox mapping and request review.

## Workflow

1. **Inspect existing architecture first**
   - Locate the current runtime adapter, action-chain system, limb controller, ownership controller, event bus, state store, and test harness.
   - Read existing contracts and tests before editing.
   - Preserve current APIs and backward compatibility unless a migration is explicitly approved.
   - Do not duplicate an existing controller merely because it is not yet wired into runtime.
2. **Runtime capability discovery**
   - Verify SDK/Core/Framework/runtime versions and available parameter APIs.
   - Verify model load/unload lifecycle, state snapshot, parameter write/readback, render tick, and error reporting.
   - Separate static integration tests from runtime integration tests.
3. **Binding validation**
   - Accept only bindings with evidence and explicit verification state.
   - Check parameter IDs exist, ranges are valid, semantic target is unambiguous, and runtime can read/write the parameter.
   - Keep a mapping registry with source hash, model version, confidence, verification status, and owner.
4. **Action-chain design**
   - Define action ID, trigger, target semantic role, parameter set, interpolation, duration, easing, priority, cancellation, timeout, conflict policy, and rollback.
   - Keep actions declarative and deterministic; validate schema before execution.
   - Avoid direct low-level writes from unrelated behavior sources.
5. **Limb ownership arbitration**
   - Integrate with the existing limb ownership controller if present.
   - Define owner identity, lease/priority, acquisition, renewal, release, preemption, cancellation, and dead-owner recovery.
   - Resolve conflicts across chat intent, autonomous animation, motion playback, physics, and manual user control.
   - Manual user control should have an explicit highest-priority policy unless product requirements specify otherwise.
   - Ensure no two incompatible sources concurrently own the same limb/parameter group.
6. **Execution safety**
   - Require explicit authorization before actions that visibly move the user's model or persist runtime state.
   - Use bounded parameter values and frame/tick budgets.
   - Snapshot state before risky sequences; rollback on failure or cancellation.
   - Do not alter original MOC3 or texture assets.
7. **Regression and independent QA**
   - Unit-test mapping validation, arbitration, cancellation, preemption, timeout, rollback, and malformed action chains.
   - Integration-test runtime read/write and render update where runtime is available.
   - Test missing model, missing parameter, stale source hash, conflicting owners, worker failure, and SDK mismatch.
   - Compare behavior against existing baselines; flag regressions rather than silently updating expected output.
   - Verify SQLite consistency and artifact provenance.
8. **Release handoff**
   - Provide architecture findings, files changed, compatibility notes, action-chain schema, ownership policy, test matrix/results, rollback instructions, unresolved risks, and recommended follow-up PRs.

## MCP capabilities

Use verified capabilities when present:
- `l2d_register_action_chain`
- `l2d_validate_action_chain`
- `l2d_execute_action_chain`
- `l2d_get_runtime_state`
- `l2d_rollback_action`

Tool names in this document are capability contracts, not proof that the server implements them. Discover and validate actual schemas before calling.

## Acceptance criteria

- Existing controllers are reused, not duplicated.
- Unverified semantic hypotheses cannot drive production controls.
- Every runtime mapping traces to source/model hashes and evidence.
- Ownership arbitration is deterministic and tested across behavior sources.
- Cancellation and rollback are implemented and tested.
- No original model assets are modified.
- Runtime changes have regression evidence and a clear rollback path.

## Restrictions

Do not make unapproved live changes. Do not bypass licensing. Do not expose arbitrary shell or filesystem access through MCP. Do not claim GPU acceleration or parallel processing without measured evidence.
