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
 * 抢占时要不要立刻补播还挂着的关闭动作。
 * 新链里只要有 motion 步骤，就交给新动作覆盖，这里返回空，避免和状态机撞车。
 * 新链不带 motion（表情、视线、姿势）时，把还没跑的 closeMotion 原样补播。
 */
export function closeMotionsOnPreempt(
  pending: readonly string[] | null | undefined,
  incoming: readonly { kind?: string }[] | null | undefined,
): string[] {
  if (chainHasMotion(incoming)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of pending || []) {
    if (typeof name !== 'string' || !name || seen.has(name)) continue;
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
  type: 'action-done';
  phase: ActEventPhase;
  runId: number;
  priority: ActPriority;
  callId: number | null;
  source: string;
  steps: number;
  reason?: string;
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

function doneEvent(run: ActiveAct, phase: ActEventPhase, reason?: string): ActionDoneEvent {
  const event: ActionDoneEvent = {
    type: 'action-done',
    phase,
    runId: run.runId,
    priority: run.priority,
    callId: run.callId,
    source: run.source,
    steps: run.steps,
  };
  if (reason) event.reason = reason;
  return event;
}

export class ActGate {
  private seq = 0;
  private active: ActiveAct | null = null;

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
    if (current) events.push(doneEvent(current, 'interrupted', 'preempted'));

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
    const event = doneEvent(this.active, 'end');
    this.active = null;
    return event;
  }

  /** 主动撤下当前链，例如邪神退出。runId 对不上不动。 */
  release(runId?: number, reason = 'released'): ActionDoneEvent | null {
    if (!this.active) return null;
    if (runId != null && this.active.runId !== runId) return null;
    const event = doneEvent(this.active, 'interrupted', reason);
    this.active = null;
    return event;
  }
}
