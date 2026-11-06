/**
 * 动作链的优先级门闩。
 *
 * 调度仍是 overlay 里的 executePokeAction（定时步骤、气泡、收招）。
 * 这里只决定「这条新链能不能占上当前槽」，以及 start / end / interrupted 回执的形状。
 * 不另开一套调度器。
 *
 * 规则：BACKGROUND < NORMAL < FORCE。
 * 低优先级不能打断高优先级；同级可以打断。没有在播的链时，任何优先级都能开始。
 */

export const ACT_PRIORITIES = ['BACKGROUND', 'NORMAL', 'FORCE'] as const;
export type ActPriority = (typeof ACT_PRIORITIES)[number];

/** 数值只用于比较，调用方写枚举名，不写数字。 */
export const ACT_PRIORITY_RANK: Record<ActPriority, number> = {
  BACKGROUND: 10,
  NORMAL: 50,
  FORCE: 90,
};

export type ActPhaseName = 'listening' | 'thinking' | 'speaking' | 'settle';
export type ActEventPhase = 'start' | 'end' | 'interrupted';

export interface ActStep {
  kind: 'expression' | 'motion' | 'pose' | 'look';
  name?: string;
  /** true 时清表情，回到默认脸。收尾短链用，不写嘴部参数。 */
  clear?: boolean;
  closeMotion?: string;
  closeAfterMs?: number;
  delayMs?: number;
  pose?: { right?: 'rest' | 'finger' | 'grass' | 'chest'; left?: 'rest' | 'finger' | 'grass' | 'chest' };
  x?: number;
  y?: number;
}

export interface ActPhaseTemplate {
  id: ActPhaseName;
  label: string;
  priority: ActPriority;
  chain: ActStep[];
}

/**
 * 聆听 / 思考 / 说话 / 收尾。每段 2～4 步，只走 expression / motion / pose / look。
 * 说话段也不写 ParamMouthOpenY，口型仍留给以后的音频链路。
 */
export const ACT_PHASE_TEMPLATES: Record<ActPhaseName, ActPhaseTemplate> = {
  listening: {
    id: 'listening',
    label: '聆听',
    priority: 'FORCE',
    chain: [
      { kind: 'look', x: 0, y: 0.05 },
      { kind: 'expression', name: '兔牙', delayMs: 180 },
      { kind: 'pose', pose: { right: 'rest', left: 'rest' }, delayMs: 160 },
    ],
  },
  thinking: {
    id: 'thinking',
    label: '思考',
    priority: 'FORCE',
    chain: [
      { kind: 'expression', name: '＞＜' },
      { kind: 'look', x: 0.35, y: 0.45, delayMs: 160 },
      { kind: 'pose', pose: { right: 'finger' }, delayMs: 200 },
    ],
  },
  speaking: {
    id: 'speaking',
    label: '说话',
    priority: 'FORCE',
    chain: [
      { kind: 'expression', name: '兔牙' },
      { kind: 'look', x: 0, y: 0, delayMs: 120 },
      {
        kind: 'motion',
        name: '竖手指打开',
        closeMotion: '竖手指关闭',
        closeAfterMs: 2800,
        delayMs: 180,
      },
    ],
  },
  settle: {
    id: 'settle',
    label: '收尾',
    priority: 'NORMAL',
    chain: [
      { kind: 'look', x: 0, y: 0 },
      { kind: 'pose', pose: { right: 'rest', left: 'rest' }, delayMs: 220 },
      { kind: 'expression', clear: true, delayMs: 280 },
    ],
  },
};

const MOUTH_KEYS = ['ParamMouthOpenY', 'ParamMouthOpen', 'ParamMouthForm'];

export function parseActPriority(value: unknown): ActPriority {
  if (typeof value === 'string') {
    const key = value.trim().toUpperCase();
    if (key === 'BACKGROUND' || key === 'NORMAL' || key === 'FORCE') return key;
  }
  return 'NORMAL';
}

export function canInterruptAct(current: ActPriority | null, incoming: ActPriority): boolean {
  if (!current) return true;
  return ACT_PRIORITY_RANK[incoming] >= ACT_PRIORITY_RANK[current];
}

export function chainHasMotion(chain: readonly { kind?: string }[] | null | undefined): boolean {
  if (!chain) return false;
  return chain.some((step) => !!step && step.kind === 'motion');
}

/**
 * PR-D（PRD-RUNTIME-EVENT）：一条链里「会自然收敛、可产出真实完成事件」的步骤数。
 *
 * motion 步骤计 1 —— 但 Loop 动作不产出完成事件（Cubism onFinishedMotionHandler
 * 对 Loop 不触发），期望永远差额 → overlay 等不到真实完成 → 落回预估兜底，fail-closed。
 * keyframes 仅非 loop 计 1（loop 无终点）；expression / pose / look 即时收敛不计。
 * overlay 侧语义：seen >= expected 时提前 finishAct（真实完成），否则沿用预估兜底。
 */
export function countRealCompletions(
  chain: readonly { kind?: string; loop?: boolean }[] | null | undefined,
): number {
  if (!chain) return 0;
  let count = 0;
  for (const step of chain) {
    if (!step) continue;
    if (step.kind === 'motion') count++;
    else if (step.kind === 'keyframes' && step.loop !== true) count++;
  }
  return count;
}

export type MotionResultKind = 'ok' | 'skip' | 'fail';

/**
 * 成对动作的结果分三类。
 * ok：播出去了。
 * skip：本来就开着或关着，手的状态已经是对的，不算失败。
 * fail：被状态机拒绝或被正在播的动作吞掉。
 */
export function motionResultKind(
  result: { status?: string; reason?: string } | null | undefined,
): MotionResultKind {
  if (!result || result.status === 'ok' || !result.status) return 'ok';
  if (result.status === 'skipped') return 'skip';
  if (result.reason === 'already-open' || result.reason === 'already-closed') return 'skip';
  return 'fail';
}

/**
 * 抢占时要补播哪些还挂着的关闭动作。
 * 新链没有 motion 时，原样补播，避免手停在半空。
 * 新链有 motion 时，按同一只手判断：和待关闭动作同一只手的不补播，交给新动作覆盖；
 * 另一只手的关闭留在返回值里，由调用方排在新动作之后再播。
 * sharesArm 由 motion-director 提供。没拿到手臂判断时，有 motion 就不补播，免得和状态机撞车。
 */
export function closeMotionsOnPreempt(
  pending: readonly string[] | null | undefined,
  incoming: readonly { kind?: string; name?: string }[] | null | undefined,
  sharesArm?: (closeName: string, motionName: string) => boolean,
): string[] {
  const motions: string[] = [];
  for (const step of incoming || []) {
    if (step && step.kind === 'motion' && typeof step.name === 'string' && step.name) motions.push(step.name);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of pending || []) {
    if (typeof name !== 'string' || !name || seen.has(name)) continue;
    if (motions.length) {
      const sameHand = !sharesArm || motions.some((motion) => sharesArm(name, motion));
      if (sameHand) continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 被抢走的是不是邪神占着的那条槽。
 * 调度器在 admit 成功之后看 current（被打断的那条），不要对已经换成新 runId 的槽再 release。
 */
export function preemptedYandere(
  current: { source?: string; runId?: number } | null | undefined,
  yandere: { on?: boolean; runId?: number } | null | undefined,
): boolean {
  if (!yandere || !yandere.on || !current) return false;
  if (current.source === 'yandere') return true;
  return !!yandere.runId && current.runId === yandere.runId;
}

export function getActPhaseTemplate(name: unknown): ActPhaseTemplate | null {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase() as ActPhaseName;
  return ACT_PHASE_TEMPLATES[key] || null;
}

/** 模板里一旦出现口型参数就返回 true。单测用来守住禁区。 */
export function actTemplateWritesMouth(template: ActPhaseTemplate): boolean {
  const blob = JSON.stringify(template);
  return MOUTH_KEYS.some((key) => blob.includes(key));
}

export interface ActionDoneEvent {
  /** 事件产生时刻（ms）。end.ts - start.ts 才是链的真实收敛耗时。 */
  ts?: number;
  type: 'action-done';
  phase: ActEventPhase;
  runId: number;
  priority: ActPriority;
  callId: number | null;
  source: string;
  steps: number;
  /** 动作真的没播成：被拒或被吞。正常跳过不写这里。 */
  reason?: string;
  /** already-open / already-closed 这类正常跳过，不表示失败。 */
  notes?: string[];
}

export interface ActiveAct {
  runId: number;
  priority: ActPriority;
  callId: number | null;
  source: string;
  steps: number;
}

export interface ActAdmission {
  accepted: boolean;
  reason?: 'priority-blocked';
  runId: number | null;
  priority: ActPriority;
  source: string;
  current: { runId: number; priority: ActPriority; source: string } | null;
  /** 本次准入要发出的回执。被拒时为空；抢占成功时先是旧链的 interrupted，再是新链的 start。 */
  events: ActionDoneEvent[];
}

export interface ActAdmitInput {
  priority?: unknown;
  callId?: number | null;
  source?: string;
  steps?: number;
}

function snapshot(run: ActiveAct): { runId: number; priority: ActPriority; source: string } {
  return { runId: run.runId, priority: run.priority, source: run.source };
}

function doneEvent(
  run: ActiveAct,
  phase: ActEventPhase,
  reason?: string,
  notes?: string[],
): ActionDoneEvent {
  const event: ActionDoneEvent = {
    type: 'action-done',
    phase,
    // 事件自发时间戳：回执里没有它，「多久收敛」在任何一层都只能靠观测时刻倒推，
    // 会把轮询间隔算成用户的延迟。
    ts: Date.now(),
    runId: run.runId,
    priority: run.priority,
    callId: run.callId,
    source: run.source,
    steps: run.steps,
  };
  if (reason) event.reason = reason;
  if (notes && notes.length) event.notes = notes.slice();
  return event;
}

export class ActGate {
  private seq = 0;
  private active: ActiveAct | null = null;
  /** 真正没播成。结束回执的 reason 只用这个。 */
  private motionFail: { runId: number; reason: string } | null = null;
  /** 正常跳过，结束回执放 notes，不当成失败。 */
  private motionSkips: { runId: number; notes: string[] } | null = null;

  /**
   * kind 为 skip 时记进 notes（already-open 这类）。
   * 缺省和 fail 记第一个失败原因。runId 对不上就忽略。
   */
  noteMotion(runId: number, reason: string, kind: 'fail' | 'skip' = 'fail'): void {
    if (!reason || !this.active || this.active.runId !== runId) return;
    if (kind === 'skip') {
      if (!this.motionSkips || this.motionSkips.runId !== runId) this.motionSkips = { runId, notes: [] };
      if (this.motionSkips.notes.indexOf(reason) < 0) this.motionSkips.notes.push(reason);
      return;
    }
    if (this.motionFail && this.motionFail.runId === runId) return;
    this.motionFail = { runId, reason };
  }

  current(): ActiveAct | null {
    return this.active ? { ...this.active } : null;
  }

  /**
   * 尝试让一条新链占上槽。
   * 成功时若已有链，旧链得到 interrupted，新链得到 start。
   * 被更高优先级挡住时不改当前槽，也不发回执。
   */
  admit(input: ActAdmitInput = {}): ActAdmission {
    const priority = parseActPriority(input.priority);
    const source = input.source || 'act';
    const current = this.active;
    if (current && !canInterruptAct(current.priority, priority)) {
      return {
        accepted: false,
        reason: 'priority-blocked',
        runId: null,
        priority,
        source,
        current: snapshot(current),
        events: [],
      };
    }

    const events: ActionDoneEvent[] = [];
    if (current) {
      // 被抢占也是正常结束路径：此前已经发生的降级/超时事实必须留在回执里，
      // 否则「并行组降级」这类 notes 会因为一条 ambient 链插队而凭空消失。
      const pending = this.motionSkips && this.motionSkips.runId === current.runId
        ? this.motionSkips.notes.slice()
        : undefined;
      events.push(doneEvent(current, 'interrupted', 'preempted', pending));
    }
    this.motionFail = null;
    this.motionSkips = null;

    const next: ActiveAct = {
      runId: ++this.seq,
      priority,
      callId: input.callId ?? null,
      source,
      steps: input.steps ?? 0,
    };
    this.active = next;
    events.push(doneEvent(next, 'start'));
    return {
      accepted: true,
      runId: next.runId,
      priority,
      source,
      current: current ? snapshot(current) : null,
      events,
    };
  }

  /** 自然播完。runId 对不上（已被打断或本来就不是这条）则忽略。 */
  finish(runId: number): ActionDoneEvent | null {
    if (!this.active || this.active.runId !== runId) return null;
    const reason = this.motionFail && this.motionFail.runId === runId ? this.motionFail.reason : undefined;
    const notes = this.motionSkips && this.motionSkips.runId === runId ? this.motionSkips.notes : undefined;
    this.motionFail = null;
    this.motionSkips = null;
    const event = doneEvent(this.active, 'end', reason, notes);
    this.active = null;
    return event;
  }

  /** 主动撤下当前链，例如邪神退出。runId 对不上不动。 */
  release(runId?: number, reason = 'released'): ActionDoneEvent | null {
    if (!this.active) return null;
    if (runId != null && this.active.runId !== runId) return null;
    // 与 admit 的抢占路径同口径：结束原因不影响已发生的降级事实。
    const pending = this.motionSkips && this.motionSkips.runId === this.active.runId
      ? this.motionSkips.notes.slice()
      : undefined;
    this.motionFail = null;
    this.motionSkips = null;
    const event = doneEvent(this.active, 'interrupted', reason, pending);
    this.active = null;
    return event;
  }
}
