/**
 * Cue Bridge（M1-f 第二批 F2-1）：EmbodiedCue 编译 → 时间线准入 → 账本 → 帧写值的接线纯逻辑。
 *
 * 分工（与 core 的 cue-loop.ts 一起构成完整闭环）：
 * - core：compileEmbodiedCue 的 fail-closed 校验 + commitCue/tickCue/releaseCue/cueWrites
 *   的纯状态机（同通道替换、跨通道并存、到期、clear、overlay 单槽）；
 * - 本文件：把 core 的四产物接到渲染运行面——
 *   segments → admitGesture（gesture-timeline 的既有冲突/优先级判定，唯一准入闸），
 *   stops    → stopGesture（group = 'cue:<channel>' 收窄），
 *   overlays → setExpression / clearExpression（Cubism 表情单槽），
 *   writes   → writeParam 注入端口（渲染层接 ParamInjector.applyNow，禁止第二套写通道）。
 *
 * 关键不变量：
 * 1. flag 关 → 零副作用：不 commit、不进时间线、不碰表情、不产写值（回滚要求）；
 * 2. 时间线拒绝 → 账本不落账（commit 只在 gate.accepted 之后），零半产出；
 * 3. clear 是显式释放（与 stopGesture 同语义），不受 priority 限制；
 * 4. tick 先到期清理再产写值：到期帧不再写旧值（INV-5 同型）；
 * 5. 写值只经 writeParam 端口（生产环境 = injector.applyNow），本文件不碰模型/GL；
 * 6. 口型参数在准入期即拒绝（红线前置）；物理输出参数先 own 再写，own 失败即拒
 *    （未授权物理写由 injector.set 兜底，双保险）。
 *
 * 前置：cue 的 hold/transition 依赖 gesture-timeline，因此 `enabled` 由渲染层装配为
 * `embodied.cue && embodied.timeline`（timeline 关 → 本 bridge 整体 disabled）。
 */
import {
  commitCue,
  cueSnapshot,
  cueWrites,
  emptyCueLoop,
  releaseCue,
  tickCue,
  type CueCommitOptions,
  type CueLoopState,
  type CueReleaseSelector,
  type CueSnapshot,
} from '../../../core/src/cue-loop.ts';
import { CUE_SEED_BINDINGS, type CueChannelBinding, type EmbodiedCue } from '../../../core/src/embodied-cue.ts';
import type { GestureSegment } from '../../../core/src/gesture-timeline.ts';

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** 长期持有的物理输出认领时长（到期兜底；clear/到期仍显式 release）。 */
export const LONG_CUE_OWN_MS = 24 * 60 * 60 * 1000;

/** 时间线准入回执（GestureAdmission 的结构子集）。 */
export interface CueGestureGate {
  admitted: boolean;
  entryId?: string;
  rejected?: Array<{ id: string; reason: string }>;
}

export interface CueBridgeDeps {
  /** 复合 flag：embodied.cue 且 embodied.timeline（timeline 关时 hold 无准入门）。 */
  enabled: boolean;
  /** 时间线准入（hold/transition 必填；缺省 = 拒绝 'timeline-unavailable'）。 */
  admitGesture?(segments: readonly GestureSegment[], opts: { entryId?: string }): CueGestureGate | null | undefined;
  /** 按 group 释放时间线租约（clear / 到期 / stop）。 */
  stopGesture?(selector: { group: string }): unknown;
  /** 表情打开（返回 false = 模型无该表情，按 fail-closed 拒整条 cue）。 */
  setExpression?(name: string): boolean;
  /** 表情关闭（Cubism 单槽，clearExpression 清当前层）。 */
  clearExpression?(): boolean;
  /** 合法表情清单（model3.json）；缺省不校验（由 setExpression 返回值兜底）。 */
  knownOverlays?(): readonly string[] | undefined;
  /** 写值注入端口（生产 = ParamInjector.applyNow，返回是否真正写入）；缺省只产出 writes。 */
  writeParam?(id: string, value: number): boolean;
  /** 口型红线（生产 = LIPSYNC_PARAMS）；命中即准入拒绝。 */
  isMouthParam?(id: string): boolean;
  /** 物理输出判定（生产 = injector.isPhysicsOutput）；命中者先 own 再写。 */
  isPhysicsOutput?(id: string): boolean;
  /** 认领物理输出（生产 = injector.own）；返回实际登记 id。 */
  ownParams?(ids: string[], durationMs: number, phase: 'pre' | 'post'): string[];
  /** 释放物理输出（生产 = injector.release）。 */
  releaseOwned?(ids: string[]): string[];
  /** 词表覆盖（仅测试用；缺省 CUE_SEED_BINDINGS）。 */
  bindings?: readonly CueChannelBinding[];
  /** 注入时钟（测试用）。 */
  now?(): number;
}

export interface CueAdmitOptions {
  runId?: string;
  entryId?: string;
}

export interface CueRejection {
  channel: string;
  operation: string;
  reason: string;
}

export interface CueAdmission {
  accepted: boolean;
  /** flag 状态回显（区分「被拒」与「没开」，同 admitGesture.flagEnabled 口径）。 */
  flagEnabled: boolean;
  channel: string;
  operation: string;
  entryId?: string;
  /** 写值表（hold 场景；诊断/回执用，实际写值在每帧 tick）。 */
  writes: Record<string, number>;
  rejected: CueRejection[];
}

export interface CueTickOutcome {
  writes: Record<string, number>;
  /** 已写入/已产出写值的参数（排序）。 */
  applied: string[];
  /** 注入端口拒绝的参数（如口型/未授权物理输出；排序）。 */
  skipped: string[];
  expiredChannels: string[];
  expiredOverlay: string | null;
}

export interface CueStopOutcome {
  releasedChannels: string[];
  releasedOverlay: string | null;
}

export interface CueBridgeSnapshot extends CueSnapshot {
  enabled: boolean;
}

export interface CueBridge {
  admit(cue: EmbodiedCue | null | undefined, opts?: CueAdmitOptions): CueAdmission;
  /** 每帧：到期清理 + 当前写值表（写值经 writeParam 端口）。 */
  tick(now: number): CueTickOutcome;
  stop(selector?: CueReleaseSelector): CueStopOutcome;
  snapshot(): CueBridgeSnapshot;
}

const emptyAdmission = (
  flagEnabled: boolean,
  channel: string,
  operation: string,
  reason: string,
): CueAdmission => ({
  accepted: false,
  flagEnabled,
  channel,
  operation,
  writes: {},
  rejected: [{ channel, operation, reason }],
});

/**
 * 创建 cue bridge（index.ts 装配一次；测试可多次创建）。
 * 全部状态（账本 + 时间线租约 + 物理输出认领）收口在 admit/tick/stop 三个入口。
 */
export function createCueBridge(deps: CueBridgeDeps): CueBridge {
  let state: CueLoopState = emptyCueLoop();
  /** channel → 本 bridge 认领的物理输出（clear/到期/stop 释放）。 */
  const ownedByChannel = new Map<string, string[]>();
  const bindings = deps.bindings ?? CUE_SEED_BINDINGS;

  const releaseChannelOwned = (channels: readonly string[]): void => {
    const ids: string[] = [];
    for (const channel of channels) {
      const list = ownedByChannel.get(channel);
      if (list) {
        ids.push(...list);
        ownedByChannel.delete(channel);
      }
    }
    if (ids.length) deps.releaseOwned?.(ids);
  };

  const stopGroups = (channels: readonly string[]): void => {
    for (const channel of channels) deps.stopGesture?.({ group: 'cue:' + channel });
  };

  const paramIdsOf = (segments: readonly GestureSegment[]): string[] =>
    [...new Set(segments.flatMap((s) => Object.keys(s.params ?? {})))].sort((a, b) => a.localeCompare(b));

  const admit = (cue: EmbodiedCue | null | undefined, opts: CueAdmitOptions = {}): CueAdmission => {
    const channel = cue && typeof cue === 'object' && typeof cue.channel === 'string' ? cue.channel : '*';
    const operation = cue && typeof cue === 'object' && typeof cue.operation === 'string' ? cue.operation : '*';

    // 1. flag 关：零副作用（不编译、不入队、不动表情）。
    if (!deps.enabled) return emptyAdmission(false, channel, operation, 'disabled');

    const now = deps.now?.() ?? nowMs();
    const knownOverlays = operation === 'overlay' ? deps.knownOverlays?.() : undefined;
    const preview = commitCue(state, cue, bindings, now, {
      runId: opts.runId,
      knownOverlays,
    } as CueCommitOptions);

    if (!preview.accepted) {
      return {
        accepted: false,
        flagEnabled: true,
        channel,
        operation,
        writes: {},
        rejected: preview.rejected,
      };
    }

    // 2. 口型红线前置（生产环境 injector.set 仍会兜底拒绝，这里给出准入期明确原因）。
    const domainIds = paramIdsOf(preview.compiled.segments);
    if (deps.isMouthParam) {
      const mouth = domainIds.find((id) => deps.isMouthParam!(id));
      if (mouth) return emptyAdmission(true, channel, operation, 'mouth-param');
    }

    // 3. 物理输出：写前必须 own（与 injector「未授权物理写拒绝」双保险）。
    const physicsIds = deps.isPhysicsOutput ? domainIds.filter((id) => deps.isPhysicsOutput!(id)) : [];
    const prevOwned = ownedByChannel.get(channel) ?? [];
    const toOwn = physicsIds.filter((id) => !prevOwned.includes(id));
    let newlyOwned: string[] = [];
    if (toOwn.length) {
      const ttl = typeof cue?.durationMs === 'number' && cue.durationMs > 0 ? cue.durationMs : LONG_CUE_OWN_MS;
      newlyOwned = (deps.ownParams?.(toOwn, ttl, 'post') ?? []).slice();
      if (newlyOwned.length !== toOwn.length) {
        if (newlyOwned.length) deps.releaseOwned?.(newlyOwned);
        return emptyAdmission(true, channel, operation, 'physics-output-not-owned');
      }
    }

    // 4. 表情打开失败（模型无该表情）→ 不落账、不透支时间线（overlay 无 segments）。
    const overlayBefore = state.overlay;
    for (const ov of preview.compiled.overlays) {
      if (!ov.on) continue;
      if (deps.setExpression && deps.setExpression(ov.name) === false) {
        if (newlyOwned.length) deps.releaseOwned?.(newlyOwned);
        return emptyAdmission(true, channel, operation, 'unknown-overlay');
      }
    }

    // 5. 时间线准入（hold/transition）：拒绝即账本不落账（零半产出）。
    if (preview.compiled.segments.length) {
      const gate = deps.admitGesture?.(preview.compiled.segments, { entryId: opts.entryId });
      if (!gate) {
        if (newlyOwned.length) deps.releaseOwned?.(newlyOwned);
        return emptyAdmission(true, channel, operation, 'timeline-unavailable');
      }
      if (!gate.admitted) {
        if (newlyOwned.length) deps.releaseOwned?.(newlyOwned);
        const reason = gate.rejected?.[0]?.reason ?? 'priority-blocked';
        return emptyAdmission(true, channel, operation, reason);
      }
    }

    // 6. 落账（此后产物生效）。
    state = preview.state;

    // 7. 物理输出认领账：同通道替换时只释放不再需要的旧参数，避免误放新认领。
    if (physicsIds.length) {
      const keep = prevOwned.filter((id) => physicsIds.includes(id));
      const drop = prevOwned.filter((id) => !physicsIds.includes(id));
      if (drop.length) deps.releaseOwned?.(drop);
      ownedByChannel.set(channel, [...keep, ...newlyOwned]);
    } else if (prevOwned.length) {
      releaseChannelOwned([channel]);
    }

    // 8. clear 的显式释放：时间线按 group 收窄；表情只在目标匹配时关闭
    //    （编译层 target 不匹配也会产 off 开关，这里以落账前的当前层为准兜底）。
    if (preview.compiled.stops.length) {
      for (const sel of preview.compiled.stops) deps.stopGesture?.(sel as { group: string });
    }
    if (channel && operation === 'clear') {
      const target = cue?.target;
      for (const ov of preview.compiled.overlays) {
        if (!ov.on && (target === undefined || overlayBefore?.name === target)) deps.clearExpression?.();
      }
    }

    const writes = cueWrites(state, bindings).writes;
    return {
      accepted: true,
      flagEnabled: true,
      channel,
      operation,
      entryId: preview.compiled.segments.length ? opts.entryId : undefined,
      writes,
      rejected: [],
    };
  };

  const tick = (now: number): CueTickOutcome => {
    if (!deps.enabled) {
      return { writes: {}, applied: [], skipped: [], expiredChannels: [], expiredOverlay: null };
    }
    const t = Number.isFinite(now) ? now : nowMs();
    const frame = tickCue(state, t);
    if (frame.state !== state) {
      state = frame.state;
      stopGroups(frame.expiredChannels);
      releaseChannelOwned(frame.expiredChannels);
      if (frame.expiredOverlay) deps.clearExpression?.();
    }
    const writes = cueWrites(state, bindings).writes;
    const ids = Object.keys(writes).sort((a, b) => a.localeCompare(b));
    const applied: string[] = [];
    const skipped: string[] = [];
    if (deps.writeParam) {
      for (const id of ids) {
        if (deps.writeParam(id, writes[id])) applied.push(id);
        else skipped.push(id);
      }
    } else {
      applied.push(...ids);
    }
    return {
      writes,
      applied,
      skipped,
      expiredChannels: frame.expiredChannels,
      expiredOverlay: frame.expiredOverlay,
    };
  };

  const stop = (selector?: CueReleaseSelector): CueStopOutcome => {
    if (!deps.enabled) return { releasedChannels: [], releasedOverlay: null };
    const result = releaseCue(state, selector);
    state = result.state;
    stopGroups(result.releasedChannels);
    releaseChannelOwned(result.releasedChannels);
    if (!selector) {
      // 全清兜底：selector 缺省时把仍记录的所有 channel 认领一并释放。
      releaseChannelOwned([...ownedByChannel.keys()]);
    }
    if (result.releasedOverlay) deps.clearExpression?.();
    return { releasedChannels: result.releasedChannels, releasedOverlay: result.releasedOverlay };
  };

  const snapshot = (): CueBridgeSnapshot => ({
    enabled: deps.enabled,
    ...cueSnapshot(state, bindings),
  });

  return { admit, tick, stop, snapshot };
}
