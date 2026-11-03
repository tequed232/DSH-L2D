/**
 * Workspace Action Protocol（双向动作协议）· 纯契约层。
 *
 * 设计原则（对应 docs/Host-API-Audit.md 的复用结论）：
 *   - **不新建通信层**。请求关联复用 aiInbox 的 callId（requestId ↔ callId 一对一映射），
 *     上下文复用 buildWorkspaceContextSnapshot（W1），权限复用 host-guard，
 *     宿主→Agent 的投递复用 workspace-agent 桥的 controller.prompt(requestId)。
 *   - Agent 返回的一切动作**都不可信**：必须过 validateAgentActionBlock + 宿主白名单才能执行。
 *   - `accepted ≠ completed`：accepted 只是入队；只有执行回执确认后才 completed。
 *   - 上下文精简：trimWorkspaceContext 只保留与当前动作相关的字段，并限制体积。
 */

/** 动作请求（宿主 → Agent / 执行通道）。 */
export interface WorkspaceActionRequest {
  requestId: string;
  type: 'workspace.action';
  action: {
    /** 必须是宿主白名单内的工具名（l2d_*）；白名单校验在宿主守卫层 */
    name: string;
    target?: string;
    parameters?: Record<string, unknown>;
  };
  workspace: {
    id: string;
    name: string;
    type: string;
    currentActivity?: string;
    activeResource?: { id?: string; name: string; type: string };
    /** 一句话状态摘要（来自 W1 快照，脱敏后） */
    stateSummary?: string;
  };
  user: {
    intent: string;
    message?: string;
  };
  responseFormat: {
    requireAction: true;
    requireSummary: true;
    language: 'zh-CN';
  };
}

export type WorkspaceActionStatus =
  | 'accepted'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'failed';

/** 动作响应（Agent / 执行通道 → 宿主）。 */
export interface WorkspaceActionResponse {
  requestId: string;
  type: 'workspace.action.result';
  status: WorkspaceActionStatus;
  action: { name: string; target?: string; parameters?: Record<string, unknown> };
  /** 面向用户的一句话摘要（zh-CN），不暴露原始 JSON */
  summary: string;
  result?: { success: boolean; message: string };
  followUp?: { required: boolean; description?: string };
}

const REQUEST_ID_RE = /^[\w.-]{4,64}$/;

/** 校验请求信封。返回错误列表；空数组 = 合法。 */
export function validateWorkspaceActionRequest(req: unknown): string[] {
  const errors: string[] = [];
  if (!req || typeof req !== 'object') return ['request 必须是对象'];
  const r = req as Partial<WorkspaceActionRequest>;
  if (typeof r.requestId !== 'string' || !REQUEST_ID_RE.test(r.requestId)) {
    errors.push('requestId 必须是 4~64 位 [\\w.-] 字符串');
  }
  if (r.type !== 'workspace.action') errors.push('type 必须是 workspace.action');
  const action = r.action as Partial<WorkspaceActionRequest['action']> | undefined;
  if (!action || typeof action.name !== 'string' || !action.name.trim()) {
    errors.push('action.name 必填');
  }
  if (r.action && r.action.parameters !== undefined && (typeof r.action.parameters !== 'object' || r.action.parameters === null)) {
    errors.push('action.parameters 必须是对象');
  }
  const ws = r.workspace as Partial<WorkspaceActionRequest['workspace']> | undefined;
  if (!ws || typeof ws.id !== 'string' || !ws.id.trim()) errors.push('workspace.id 必填');
  if (r.user && r.user.intent !== undefined && typeof r.user.intent !== 'string') {
    errors.push('user.intent 必须是字符串');
  }
  return errors;
}

/** 校验 Agent 回复里的动作块（不可信输入，fail-closed）。 */
export function validateAgentActionBlock(block: unknown): string[] {
  const errors: string[] = [];
  if (!block || typeof block !== 'object') return ['动作块必须是对象'];
  const b = block as { type?: string; action?: { name?: unknown }; requestId?: unknown };
  if (b.type !== 'workspace.action') errors.push('type 必须是 workspace.action');
  if (typeof b.requestId !== 'string' || !REQUEST_ID_RE.test(b.requestId)) {
    errors.push('requestId 缺失或格式非法');
  }
  if (!b.action || typeof b.action.name !== 'string' || !b.action.name.trim()) {
    errors.push('action.name 必填');
  }
  return errors;
}

/** 校验响应信封（宿主自己产出的也要校验，防止拼接错误流到 UI）。 */
export function validateWorkspaceActionResponse(res: unknown): string[] {
  const errors: string[] = [];
  if (!res || typeof res !== 'object') return ['response 必须是对象'];
  const r = res as Partial<WorkspaceActionResponse>;
  if (typeof r.requestId !== 'string' || !r.requestId) errors.push('requestId 缺失');
  if (r.type !== 'workspace.action.result') errors.push('type 必须是 workspace.action.result');
  const STATUSES: WorkspaceActionStatus[] = ['accepted', 'executing', 'completed', 'rejected', 'failed'];
  if (!STATUSES.includes(r.status as WorkspaceActionStatus)) errors.push('status 非法: ' + String(r.status));
  if (typeof r.summary !== 'string' || !r.summary.trim()) errors.push('summary 必填（面向用户的摘要）');
  if (!r.action || typeof (r.action as { name?: unknown })?.name !== 'string') errors.push('action.name 必填');
  return errors;
}

export interface ProtocolEvent {
  type?: string;
  phase?: string;
  reason?: string;
  /** 事件自发时间戳（ms）。action-done 事件会带；elapsedMs 靠它，不靠观测时刻倒推。 */
  ts?: number;
  /** 事件携带的真实进度（0~100）。有的话优先于按阶段的估算。 */
  progress?: number;
}

export interface ProtocolResult {
  ok?: boolean;
  reason?: string;
  error?: string;
  /** 受理回执显式声明"链还没收敛"（l2d_act 长链：settled:false, outcome:'pending'）。 */
  settled?: boolean;
}

/**
 * 状态推导（执行状态同步）。
 * accepted：仅入队；executing：看到 start 事件，或回执 ok 但 settled:false（链还在播）；
 * completed：执行回执收敛，或 end 事件（链按计划播完，事件是权威进度）；
 * rejected：宿主守卫拒绝（guard message 带入）。interrupted 视为 failed（原因可查）。
 */
export function deriveActionStatus(input: {
  queued: boolean;
  guardMessage?: string;
  events?: ProtocolEvent[];
  result?: ProtocolResult | null;
}): { status: WorkspaceActionStatus; reason?: string } {
  if (input.guardMessage) return { status: 'rejected', reason: input.guardMessage };
  const events = input.events || [];
  const started = events.some((e) => e && e.phase === 'start');
  const ended = events.some((e) => e && e.phase === 'end');
  const interrupted = events.find((e) => e && e.phase === 'interrupted');
  if (input.result) {
    if (input.result.ok === true) {
      if (interrupted) return { status: 'failed', reason: 'interrupted: ' + (interrupted.reason || 'preempted') };
      // 受理回执声明未收敛：不是 completed，链真正播完以 end 事件为准
      if (input.result.settled === false && !ended) return { status: 'executing' };
      return { status: 'completed' };
    }
    // 失败原因要透出：数组形失败（failed:[{id,reason}]）取首条，别让"execution-failed"盖住真因
    const failedList = (input.result as { failed?: unknown[] }).failed;
    const firstFail = Array.isArray(failedList) && failedList.length ? failedList[0] : null;
    const failDetail = typeof firstFail === 'string'
      ? firstFail
      : firstFail && typeof firstFail === 'object'
        ? ((firstFail as { id?: string }).id || '?') + ':' + ((firstFail as { reason?: string }).reason || 'write-failed')
        : null;
    const reason = input.result.reason || input.result.error || failDetail
      || (interrupted ? 'interrupted: ' + (interrupted.reason || 'preempted') : 'execution-failed');
    return { status: 'failed', reason };
  }
  if (interrupted) return { status: 'failed', reason: 'interrupted: ' + (interrupted.reason || 'preempted') };
  if (ended) return { status: 'completed' };
  if (started) return { status: 'executing' };
  if (input.queued) return { status: 'accepted' };
  return { status: 'failed', reason: 'unknown' };
}

/** 进度估算曲线：链内阶段 → 百分比。只是 UI 粗估，真值以事件 payload 的 progress 为准。 */
const PHASE_PERCENT: Record<ActionChainPhase, number> = { pre: 15, main: 50, post: 85, end: 100 };

export type ActionChainPhase = 'pre' | 'main' | 'post' | 'end';

export interface ActionProgress {
  /** 当前链内阶段：事件只有 start 时视为刚进 pre，看到 end 收敛为 end。 */
  phase: ActionChainPhase;
  startedAtMs?: number;
  elapsedMs?: number;
  /** 真值（事件 payload 的 progress）优先；否则按 PHASE_PERCENT 估算；推不出来是 null。 */
  percent?: number | null;
}

/**
 * 进度推导（长动作进度同步）。纯函数，不碰通信层。
 * 事件不足（空、或既无 start 也无 end）返回 null——不猜。
 */
export function deriveActionProgress(events?: ProtocolEvent[], nowMs: number = Date.now()): ActionProgress | null {
  const list = (events || []).filter((e): e is ProtocolEvent => !!e);
  if (!list.length) return null;
  const startEvent = list.find((e) => e.phase === 'start');
  const ended = list.some((e) => e.phase === 'end');
  if (!startEvent && !ended) return null;

  // 链内阶段：按事件顺序取最后一个有信息量的 phase
  let phase: ActionChainPhase | null = null;
  for (const e of list) {
    if (e.phase === 'start') phase = phase || 'pre';
    else if (e.phase === 'pre' || e.phase === 'main' || e.phase === 'post') phase = e.phase;
    else if (e.phase === 'end') phase = 'end';
  }

  const progress: ActionProgress = { phase: phase || 'pre' };
  if (startEvent && typeof startEvent.ts === 'number') {
    progress.startedAtMs = startEvent.ts;
    const endEvent = [...list].reverse().find((e) => e.phase === 'end');
    const endTs = endEvent && typeof endEvent.ts === 'number' ? endEvent.ts : undefined;
    // 已收敛用 end.ts - start.ts（链的真实耗时），还在跑用 now - start
    progress.elapsedMs = Math.max(0, (endTs ?? nowMs) - startEvent.ts);
  }

  let real: number | null = null;
  for (const e of list) {
    if (typeof e.progress === 'number' && Number.isFinite(e.progress)) {
      real = Math.max(0, Math.min(100, Math.round(e.progress)));
    }
  }
  progress.percent = real ?? (phase ? PHASE_PERCENT[phase] : null);
  return progress;
}

/** 面向用户的简短摘要（zh-CN）。给用户看的是"做了什么"，不是原始回执。 */
export function buildActionSummary(receipt: {
  applied?: unknown[];
  failed?: unknown[];
  skipped?: { channel?: string }[];
  owned?: unknown[];
  degraded?: { channel?: string }[];
  durationMs?: number;
} | null, actionName: string): string {
  if (!receipt) return `动作 ${actionName} 已受理，等待执行结果。`;
  const parts: string[] = [];
  const applied = receipt.applied || [];
  const failed = receipt.failed || [];
  const skipped = receipt.skipped || [];
  if (applied.length) parts.push(`已更新 ${applied.length} 个参数`);
  if (receipt.owned && receipt.owned.length) parts.push(`占用 ${receipt.owned.length} 个物理输出（${receipt.durationMs ?? 4000}ms 后自动释放）`);
  if (skipped.length) parts.push(`${skipped.length} 项能力不支持已跳过`);
  if (receipt.degraded && receipt.degraded.length) parts.push(`${receipt.degraded.length} 项以近似方式表达`);
  if (failed.length) parts.push(`${failed.length} 项写入失败`);
  if (!parts.length) parts.push('已执行');
  return `${actionName}：${parts.join('，')}。`;
}

/**
 * 从 Agent 的自然语言回复里提取结构化动作块（约定：```json 围栏，type=workspace.action）。
 * Agent 输出不可信——这里只负责**提取与校验**，执行前还必须过宿主白名单。
 */
export function extractAgentActionBlock(text: string): { ok: true; block: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const fence of fences) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        if (c && (c as { type?: string }).type === 'workspace.action') {
          const errors = validateAgentActionBlock(c);
          if (errors.length) return { ok: false, reason: 'invalid: ' + errors.join('; ') };
          return { ok: true, block: c as Record<string, unknown> };
        }
      }
    } catch {
      /* 围栏不是合法 JSON，继续找下一个 */
    }
  }
  return { ok: false, reason: 'no-action-block' };
}

/** 上下文精简：只保留与动作相关的字段，限制体积（避免把整个工作区历史发给 Agent）。 */
export const WORKSPACE_CONTEXT_MAX_CHARS = 1200;

export function trimWorkspaceContext(snapshot: {
  sessionId?: string | null;
  activity?: { situation?: string; confidence?: number } | null;
  presence?: { state?: string } | null;
} | null, overrides: { id: string; name: string; type: string }): WorkspaceActionRequest['workspace'] {
  const situation = snapshot?.activity?.situation || 'unknown';
  const presence = snapshot?.presence?.state || 'unknown';
  const stateSummary = `情境 ${situation}（置信 ${snapshot?.activity?.confidence ?? '?'}），用户状态 ${presence}`;
  return {
    id: overrides.id,
    name: overrides.name,
    type: overrides.type,
    currentActivity: situation,
    activeResource: { name: 'Live2D 角色', type: 'live2d' },
    stateSummary: stateSummary.slice(0, 300),
  };
}
