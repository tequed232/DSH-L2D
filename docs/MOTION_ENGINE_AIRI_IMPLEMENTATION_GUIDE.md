# Motion Engine：多模型通用具身运动系统实施规范

> Status: implementation specification for `feat/model-agnostic-motion-engine`
> Architecture: semantic intent + model capability adapter + local trajectory generation + unified runtime mixer
> Scope: Live2D first, other avatar runtimes through adapters; never assume one model's parameter IDs or motion assets.

## 1. Goals and non-goals

Build a reusable motion-control system that lets the behavior agent request natural, coordinated actions while keeping all frame-by-frame control deterministic and local.

Goals:
- Combine parameter-driven motion and authored motion assets (Cubism motion3 first).
- Keep LLM output semantic and low-frequency; never ask it to emit per-frame values or arbitrary parameter IDs.
- Support multiple models with different parameter IDs, ranges, motion groups, expressions, physics and missing capabilities.
- Preserve existing core mixer and renderer update scheduler; extend them instead of creating parallel pipelines.
- Make transitions, interruption, recovery, priority, parameter ownership and receipts explicit.
- Provide graceful capability-based degradation.

Non-goals for the first implementation:
- Inventing unsupported arm/hand articulation.
- Generating new motion3 assets in code.
- Assuming every model has independent left/right limbs.
- Replacing the current Cubism runtime or changing all existing behavior APIs at once.
- Treating VTube Studio or another runtime as a dependency; its external-control/event design is a protocol reference only.

## 2. Reference-project techniques to reuse

Reuse concepts and implementation patterns, not wholesale source copies. Inspect upstream licenses and versions before copying any code. Prefer clean-room reimplementation of architecture where licenses or dependencies are incompatible.

### AIRI — frame update pipeline and compositing
Reference areas to inspect:
- `packages/stage-ui-live2d/src/components/scenes/live2d/Model.vue`
- `packages/stage-ui-live2d/src/composables/live2d/motion-manager.ts`
- `packages/stage-ui-live2d/src/composables/live2d/expression-controller.ts`
- `packages/stage-ui/src/components/scenes/Stage.vue`
- `packages/model-driver-lipsync/src/live2d/index.ts`

Apply:
- A well-defined per-frame update pipeline with ordered contributors.
- Separate motion, expression, blink, gaze, breathing/idle and manual-control concerns.
- Expression blending semantics (Add / Multiply / Overwrite where supported) with explicit precedence.
- Motion groups and model capability discovery instead of hardcoded assumptions.
- Idle behavior (gaze, blink, subtle breathing) as low-priority continuous layers.
- A single final parameter-application stage to avoid modules racing to write Cubism parameters.

Do not copy AIRI's Vue/Pixi application structure into this repository. Adapt the ideas to the existing renderer and `cubismupdatescheduler.ts`.

### Open-LLM-VTuber — semantic intent boundary
Reference: `Open-LLM-VTuber` Live2D expression/motion integration and its backend-to-client event flow.

Apply:
- Convert behavior decisions into a small, validated semantic command schema.
- Keep emotion/expression, gesture, gaze and speech as coordinated but independently executable channels.
- Treat the LLM response as a request, not an imperative low-level command.
- Validate model support and policy before enqueueing execution.

### SoulLink_Live2D — smooth sequential motion
Reference: `nanlingyin/SoulLink_Live2D`.

Apply:
- Smooth transitions between action phases.
- Sequential motion segments and explicit recovery.
- Model-specific prompt/action mapping only in adapters or profile data.
- Do not use an LLM to emit arbitrary raw Cubism parameter tracks.

### AILiveVTuber-Stage — action queue and orchestration
Reference: `KKLL2025/AILiveVTuber-Stage`.

Apply:
- Priority-aware queue, deduplication, cooldown and interruption rules.
- Distinguish planning from execution.
- Track action lifecycle and return receipts.
- Prevent low-priority autonomous behavior from interrupting FORCE演出 or user-controlled actions.

### VTube Studio — external control protocol patterns
Reference: `DenchiSoft/VTubeStudio` Event API.

Apply only the useful protocol ideas: capability discovery, named commands, subscriptions/events, hotkey-like action triggers and explicit acknowledgements. Do not introduce a runtime dependency on VTube Studio.

## 3. Multi-model architecture

Use a model-independent semantic layer. The behavior planner must not know Cubism parameter IDs, motion3 filenames, model-specific expression names or renderer internals.

```
Behavior / Persona / Workspace
            |
            v
     Semantic Behavior Plan
            |
            v
      Motion Planner
            |
            v
  Capability Resolver + Adapter
       /              \
parameter tracks     authored assets
       \              /
        v            v
       Motion Contribution API
                 |
                 v
      Existing Core Mixer (extend)
                 |
                 v
       Renderer Update Scheduler
                 |
                 v
       Runtime-specific adapter
                 |
                 v
          Avatar renderer
```

### 3.1 Semantic motion vocabulary

Define stable, normalized concepts, for example:
- `head.yaw`, `head.pitch`, `head.roll`
- `gaze.x`, `gaze.y`
- `torso.lean`, `torso.sway`
- `arm.left.raise`, `arm.right.raise`
- `arm.left.extend`, `arm.right.extend`
- `hand.left.pose`, `hand.right.pose` (categorical, optional)
- `face.expression`, `face.blink`
- `body.breathing`

These are semantic channels, not promises that every model supports them. Use normalized values and semantic ranges. Avoid exposing model parameter IDs outside adapters.

### 3.2 Adapter contract

Introduce a runtime-neutral contract (names may be adjusted to match repository conventions):

```ts
type CapabilityStatus = "supported" | "approximate" | "unsupported" | "unknown";

interface SemanticChannelDescriptor {
  id: string;
  status: CapabilityStatus;
  min?: number;
  max?: number;
  neutral?: number;
  unit?: "normalized" | "degrees" | "boolean" | "categorical";
  confidence?: number;
  notes?: string;
}

interface MotionAssetDescriptor {
  id: string;
  kind: "authored-motion" | "expression" | "pose";
  supportedModels?: string[];
  tags?: string[];
  durationMs?: number;
  interruptible?: boolean;
  conflicts?: string[];
}

interface AvatarCapabilityProfile {
  runtime: string;             // e.g. cubism-web
  modelId: string;             // stable identity for the loaded model
  profileVersion: number;
  channels: SemanticChannelDescriptor[];
  assets: MotionAssetDescriptor[];
  features: {
    parameterWrite: boolean;
    authoredMotion: boolean;
    expressionBlendModes: string[];
    physics: boolean | "unknown";
    lipSync: boolean | "unknown";
  };
}

interface AvatarMotionAdapter {
  getCapabilityProfile(): AvatarCapabilityProfile;
  readSemanticState(): Record<string, number | string | boolean>;
  resolveChannel(channelId: string): ResolvedChannel | null;
  resolveAsset(assetId: string): ResolvedMotionAsset | null;
  applyFrame(contributions: ResolvedContribution[], dtMs: number): void;
  resetToNeutral?(channelIds?: string[]): void;
  dispose(): void;
}
```

The actual implementation must use existing Cubism APIs and renderer abstractions. This is a contract sketch, not a mandate to add duplicate interfaces if equivalents already exist.

### 3.3 Capability discovery and profile lifecycle

On every model load or model switch:
1. Identify the runtime and model using stable metadata/path identity (do not expose private absolute paths to LLM).
2. Discover actual writable parameters and their ranges/defaults.
3. Discover authored motions, expressions, groups and available metadata.
4. Determine parameter ownership constraints, physics outputs and known update ordering.
5. Map only verified model parameters to semantic channels.
6. Mark uncertain mappings as `unknown`; never infer support from a guessed parameter name.
7. Cache profiles by model identity + asset fingerprint + adapter version.
8. Invalidate/rebuild profile on model reload, asset change or runtime change.

A model may implement a semantic action through:
- direct parameter control;
- an authored motion asset;
- a safe composition of both;
- approximation;
- unsupported status.

The resolver should prefer the highest-fidelity safe implementation and return a structured degradation reason otherwise.

### 3.4 Extensible runtime adapters

Cubism is the first adapter, not the universal core. Keep runtime-neutral types in core. Runtime adapters own:
- parameter discovery and writes;
- asset enumeration and playback;
- runtime update hooks;
- expression blending implementation;
- physics/lip-sync integration;
- model-specific coordinate/range conversion.

Future adapters can target other 2D avatar runtimes or 3D skeletal rigs without changing Behavior Planner or semantic plans.

## 4. Motion execution model

### 4.1 Unified semantic plan

```ts
interface SemanticMotionPlan {
  decisionId: string;
  intent: string;
  priority: number;
  interruptPolicy: "never" | "phase-boundary" | "immediate";
  durationMs?: number;
  channels?: Array<{
    channel: string;
    target: number | string | boolean;
    weight?: number;
    blend?: "override" | "add" | "multiply";
    delayMs?: number;
    durationMs?: number;
  }>;
  assets?: Array<{ assetId: string; delayMs?: number; weight?: number }>;
  face?: { expression?: string; intensity?: number };
  gaze?: { target: "user" | "workspace" | "away"; intensity?: number };
  speechRef?: string;
}
```

Validate schema, priority bounds, duration bounds, channel existence and asset existence before enqueueing. LLM may request semantic targets only. The planner/adapter resolves those into local tracks.

### 4.2 Local trajectory generator

Implement deterministic local interpolation:
- linear and cubic Bezier easing initially;
- optional Hermite interpolation only if continuity tests justify it;
- per-channel velocity and acceleration limits;
- normalized range clamp and neutral pose;
- phase offsets so head, torso and arms do not start at exactly the same time;
- current-state sampling when interrupted, so recovery starts from the actual pose rather than snapping to neutral;
- deterministic seeded micro-motion only for low-priority idle channels.

No network or LLM calls in the frame loop. No per-frame allocations where practical.

### 4.3 Motion primitives

Primitive definitions describe intent and required capabilities, not raw parameter IDs. Initial candidates:
- `head.turn`, `head.tilt`, `head.nod`
- `torso.lean`, `torso.sway`
- `arm.raise`, `arm.extend`, `arm.retract`
- `hand.point` (may resolve to existing authored motion)
- `gaze.shift`
- `idle.breathe`, `idle.weight-shift`

Each primitive declares:
- required semantic channels or asset alternatives;
- optional channels;
- default trajectory/phase timings;
- interruptibility and recovery;
- conflicts and compatible layers;
- minimum capability level.

If arm channels are unavailable, the primitive may resolve to a verified authored motion (e.g. current finger-point motion) or return unsupported. Never synthesize a fake arm motion by writing unrelated parameters.

### 4.4 Gesture composition and body state

A gesture is a coordinated set of primitive tracks sharing a decisionId and timeline. Introduce a persistent BodyState abstraction only for semantic state that the active model can represent. It must not claim unsupported joints exist.

Gesture phases:
1. anticipation;
2. initiation;
3. action;
4. hold;
5. recovery.

Use per-channel phase offsets, easing and limits. Gesture composition must consult capability and parameter ownership before scheduling.

### 4.5 Mixer and parameter ownership

Extend `packages/core/src/mixer.ts`; do not create a second competing mixer.

Requirements:
- stable ordering by priority and source;
- explicit ownership per channel/parameter;
- conflict detection for multiple writers;
- blend semantics defined and tested;
- override/add/multiply only where mathematically and runtime appropriate;
- clamp to discovered parameter ranges;
- continuous low-priority layers (breathing, gaze, blink) must not overwrite high-priority gestures;
- deterministic results independent of object iteration order;
- FORCE演出 and explicit user actions have protected priority/interrupt semantics.

Do not assume all Cubism parameters can be safely combined. Physics outputs and motion-managed parameters may be read-only or require special ordering. Preserve existing mixer behavior until regression tests establish the new behavior.

### 4.6 Runtime update pipeline

Extend existing renderer scheduling (inspect `packages/renderer/src/fw/motion/cubismupdatescheduler.ts`, `motion-director.ts`, `param-injector.ts`, and model wrapper). Establish and document the actual order, adapting AIRI's plugin-pipeline concept:

1. sample model/runtime baseline;
2. advance authored motions;
3. resolve semantic trajectory contributions;
4. apply expression blending using verified runtime semantics;
5. apply gaze/blink/idle layers with ownership;
6. resolve final parameter values through the mixer;
7. apply physics in the correct Cubism-required stage;
8. update model/render.

This is a proposed logical order; the implementation must be based on the current Cubism runtime's actual required order. Do not blindly impose it if the SDK requires a different order. There must be one authoritative final write stage for externally controlled parameters.

## 5. Behavior and queue integration

- Keep Behavior Planner output semantic and low-frequency.
- Keep speech and motion execution independent but linked by `decisionId`.
- Queue lifecycle: requested → validated → queued → running → completed/interrupted/rejected/failed.
- Emit structured receipts with reason, selected adapter, resolved assets/channels, unsupported capabilities, timestamps and final state.
- Add deduplication, cooldown and bounded queue size.
- FORCE演出/user control cannot be interrupted by low-priority autonomous motion.
- A model switch cancels or safely terminates model-specific active tracks and rebuilds capabilities.
- If adapter/profile is unavailable, fall back to existing authored actions or safe rest; never crash renderer.

## 6. Implementation plan

### Phase A — audit and contracts (no behavior change)
- Read current main and PR state before coding.
- Inspect actual `mixer.ts`, `motion-director.ts`, `param-injector.ts`, `lappmodel.ts`, `cubismupdatescheduler.ts`, `pose-controller.ts`, all tests and package boundaries.
- Inspect AIRI paths listed above and document exact patterns to adapt, plus license compatibility. Also inspect Open-LLM-VTuber, SoulLink_Live2D, AILiveVTuber-Stage.
- Produce current update-order diagram, parameter ownership matrix, model capability inventory and integration plan.
- No duplicate mixer or direct edits to generated bundles.

### Phase B — capability profiles and adapter
- Add runtime-neutral interfaces in core.
- Implement Cubism adapter against actual model/runtime APIs.
- Build profile from actual model metadata and discovered assets.
- Add fixture profiles for at least two deliberately different mock models: one with arm channels, one without them; also one asset-only capability.
- Model switch invalidates profile and active model-specific tracks.

### Phase C — trajectory and mixer integration
- Extend existing core mixer with deterministic channel contributions and conflict reporting.
- Implement local trajectory engine and unit tests.
- Integrate through existing renderer scheduler; no LLM in frame loop.
- Verify authored motion and parameter control can coexist without parameter races.

### Phase D — primitives and gesture composer
- Implement only primitives supported by fixture/real model capabilities.
- Compose head/torso/arm/gaze with phase offsets and recovery.
- Provide safe fallbacks and structured unsupported results.
- Preserve current finger-point, hand-on-chest, rest, look-up/down and lean-forward assets.

### Phase E — behavior integration
- Adapt current planner to produce SemanticMotionPlan.
- Map behavior intents (thinking, explaining, listening, greeting, success, idle) to capability-aware gesture plans.
- Add queue receipts, dedupe, interruption and Persona style modifiers.
- Integrate speech by decisionId without coupling bubble lifetime to motion lifetime.

## 7. Tests and acceptance criteria

Unit tests:
- normalized channel mapping and range conversion;
- unknown/unsupported channel rejection;
- deterministic interpolation and easing;
- velocity/acceleration bounds;
- interruption starts from current sampled state;
- conflict detection and deterministic mixer ordering;
- blend semantics;
- model profile cache invalidation;
- model switching during active gesture;
- queue priority, dedupe, cooldown and FORCE protection;
- unsupported primitive degrades without crash.

Integration tests:
- two mock avatar profiles with different parameter IDs/ranges map the same semantic gesture to different native controls;
- asset-only model resolves an authored motion while parameter-capable model resolves tracks;
- parameter + motion3 hybrid does not double-write owned channels;
- real Cubism runtime screenshots/recordings verify pose continuity and no visible snapping/tearing;
- existing action chain, expressions, look tracking, idle and presence behavior regressions pass.

Performance:
- no LLM/network work in frame loop;
- bounded allocations and bounded active tracks;
- profile discovery occurs on load, not per frame;
- record frame-time overhead before/after.

Acceptance:
- Behavior layer contains no model-specific parameter IDs or asset filenames.
- At least two distinct capability profiles successfully execute the same semantic plan.
- Unsupported actions return explicit reasons.
- Existing core mixer is reused and extended.
- Runtime update order and ownership are documented.
- All automated tests pass; real runtime validation is reported separately (never claim it passed if not run).

## 8. Repository-specific guardrails

- Start from the latest main and re-check open PRs, especially PR #9, before touching overlapping files.
- Avoid simultaneous edits to `overlay.js` and current autonomous planner work.
- Keep changes modular and commits small.
- Do not modify dist/bundled artifacts unless the repository explicitly requires generated output.
- Do not add AIRI's framework stack or large dependencies merely to imitate its architecture.
- Before copying code from any upstream repository, inspect its LICENSE and preserve required notices. Architecture adaptation is preferred.
- Report changed files, commits, tests actually executed, unverified runtime checks, risks and follow-up work.
