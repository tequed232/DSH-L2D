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
}

export interface ProtocolResult {
  ok?: boolean;
  reason?: string;
  error?: string;
}

/**
 * 状态推导（执行状态同步）。
 * accepted：仅入队；executing：看到 start 事件；completed/failed：执行回执；
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
  const interrupted = events.find((e) => e && e.phase === 'interrupted');
  if (input.result) {
    if (input.result.ok === true) return { status: 'completed' };
    const reason = input.result.reason || input.result.error || (interrupted ? 'interrupted: ' + (interrupted.reason || 'preempted') : 'execution-failed');
    return { status: 'failed', reason };
  }
  if (interrupted) return { status: 'failed', reason: 'interrupted: ' + (interrupted.reason || 'preempted') };
  if (started) return { status: 'executing' };
  if (input.queued) return { status: 'accepted' };
  return { status: 'failed', reason: 'unknown' };
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
