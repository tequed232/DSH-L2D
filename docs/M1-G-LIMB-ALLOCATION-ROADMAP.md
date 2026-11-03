# M1-g：身体资源分配与四肢协调技术路线

> Status: proposal / implementation gate. This document does not claim that automatic limb allocation is implemented.

## Why this work exists

The current action chain can compile semantic cues, admit gestures, schedule timeline tracks, and write through the renderer's parameter injector. That solves action execution, but it does not yet solve **which body part should execute an intent**, whether that part can be safely taken over from physics3, or how concurrent Agent / Interaction / Autonomous requests share body resources.

This is an architectural gap, not a missing prompt. Parallel timeline tracks and parameter-domain conflict checks are not a body-part planner. A part label such as `right_arm` is also not proof that its underlying Cubism parameters are independently controllable.

The objective is safe, model-grounded allocation—not merely making the character move more often.

## Non-negotiable architecture

```text
Agent / Interaction / Autonomous
        |
        v
Behavior Request (semantic motion + hard/soft constraints)
        |
        v
Body Capability Registry <--- audited model rig + physics3 output map
        |
        v
Body Part Planner
        |
        v
Motion Allocation / Conflict Solver
        |
        v
LimbController ownership lease + Physics Output Gate
        |
        v
Existing Gesture Admission -> Gesture Timeline
        |
        v
ParamInjector (single parameter write path)
        |
        v
Cubism
```

Responsibilities:

- **Capability Registry**: model-fingerprint-scoped facts: parameter IDs/ranges, body-part mapping, physics3 writers, independent-control status, shared parameter domains, calibrated motion variants.
- **Body Part Planner**: map semantic intent to eligible body parts. Explicit user constraints are hard constraints; preferences are soft constraints; auto allocation is permitted only when capability evidence exists.
- **Allocation Solver**: atomically reserve parameter domains, detect conflicts, apply source priorities, and produce rejection / wait / preemption decisions.
- **LimbController**: lease ownership lifecycle, timeout, idempotent release, generation fencing and snapshot.
- **Physics Output Gate**: suppress physics output only for leased parameter IDs/domains. Never disable all physics merely because one limb is Agent-owned.
- **Existing execution chain**: Gesture Admission, Timeline and ParamInjector remain authoritative. Planner/solver never write Cubism parameters.

## G0 — physics and rig audit (first delivery; no runtime changes)

Audit the actual model and current renderer call graph. Deliver:

1. A parameter inventory with exact IDs, ranges and default values.
2. A physics3 output inventory: which parameters are written, whether writes are direct or buffered, and where they enter the renderer update path.
3. A body-part-to-parameter-domain mapping, identifying shared shoulder/torso/other domains.
4. Evidence for whether each domain can be independently filtered/taken over without affecting other physics outputs.
5. A write-order diagram covering physics update/output, gesture timeline, ParamInjector and Cubism render.
6. A list of unsupported / unknown capabilities. Unknown must remain unavailable; do not infer from parameter names.

Do not invent parameter IDs, claim per-limb independence from a part label, or implement automatic allocation during G0.

## G1 — safe single-part ownership integration

After G0 is reviewed, integrate the existing LimbController with the real renderer/physics adapter:

- Instantiate it in the runtime lifecycle.
- Derive `canOwn` from the audited physics output table, not hardcoded guesses.
- Gate only the exact owned parameter IDs/domains.
- Keep the feature flag OFF by default.
- Preserve physics output for every unrequested part.
- On acquire, prove the physics writer no longer wins the owned domain.
- On release, prove physics resumes smoothly.
- Make cancel, timeout, failure and duplicate release idempotent.
- Fence callbacks from stale generations.
- Do not bypass Gesture Admission or ParamInjector.

G1 scope is manual, explicit, single-limb takeover only. No automatic left/right selection and no cross-source scheduler yet.

Acceptance: acquire right-arm lease -> execute one calibrated right-arm action -> left arm/head/torso remain physics-driven -> release -> right-arm physics resumes. Repeat and inspect for stale leases / timeline writes.

## G2 — pure planner and solver design / implementation

Only after the capability contract is frozen:

```ts
type SideConstraint = "left" | "right" | "both" | "auto";
type BehaviorSource = "agent" | "interaction" | "autonomous";

interface MotionRequest {
  executionId: string;
  generation: number;
  source: BehaviorSource;
  motionId: string;
  side: SideConstraint;
  priority: number;
  durationMs: number;
}

interface AllocationDecision {
  accepted: boolean;
  selectedParts: string[];
  parameterDomains: string[];
  reason?: string;
}
```

The planner and solver must be pure and independent of DOM, Cubism, renderer instances, timers and network I/O. They produce decisions only; runtime coordination performs leases and admission.

Rules:

1. Explicit left/right/both constraints cannot silently change sides.
2. Agent explicit actions outrank ordinary autonomous idle motion.
3. Interaction may preempt Agent only under an explicit interrupt policy.
4. Autonomous behavior never preempts a busy part.
5. Unrequested parts retain their existing control source.
6. Unknown / unsupported capabilities fail closed.
7. Shared parameter domains are reserved atomically.
8. Cancel / timeout / error release idempotently.
9. Old-generation callbacks are fenced.
10. Admission success is not action completion; action receipts remain authoritative.

## Later stages

- **G3 Motion Catalog**: add left/right and combined motion variants only after model calibration.
- **G4 Cross-source coordination**: unify Agent, Interaction and Autonomous requests through one scheduler.
- **G5 Real-model acceptance**: test interruption, physics isolation/recovery, repeated lifecycle, shared domains and sustained operation.

## Required tests

- explicit right request never falls back to left;
- auto selects only a verified available variant;
- both-arm atomic request fails if either side is unavailable;
- independent left/right domains may coexist;
- shared domains cannot be double-owned;
- autonomous request yields to Agent / Interaction according to policy;
- interaction preemption cancels old timeline and fences stale callbacks;
- physics output for unrequested parts continues;
- owned physics output is suppressed only for the exact domain;
- release restores physics without a discontinuity or residual lease;
- unknown parameter / unknown capability is rejected;
- model-not-ready is BLOCKED, never PASS.

## Red lines

- No direct `core.setParameterValueById` in planner, solver or ownership modules.
- No second Cubism parameter writer.
- No bypass of Gesture Admission / Timeline / ParamInjector.
- No blanket physics3 disable for one limb.
- No automatic allocator runtime before G0 evidence and G1 real-model proof.
- No fabricated PASS; report PASS / FAIL / BLOCKED / NOT TESTED separately.

## Agent handoff

Start with G0 only. In parallel, G1 may be designed from the current LimbController API, but do not wire or enable runtime ownership until the physics output boundary is proven. G2 may prepare pure-function interfaces against a provisional contract, but must not invent model capabilities or merge runtime integration before Chief freezes the G0 manifest.

Every workstream must report: exact branch and commit, changed files, tests and commands, real-model evidence, known limitations, and explicit status. Worktrees must be created under `D:\\Desktop\\DSH-L2D产物\\`; main checkout is `D:\\Desktop\\DSH-L2D`.