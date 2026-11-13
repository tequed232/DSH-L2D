/**
 * MCP Bridge 数据契约（照设计裁决书 §三 原样落地，JSDoc typedef 形式）。
 * 所有模块间交互只允许使用这里声明的形状——禁止 Agent / MCP / Runtime 各自造格式。
 *
 * 两条硬约束（裁决书）：
 *  - requestId 是幂等标识，同一请求不得因 Agent 重试而执行两次（PR-C 落库保证）；
 *  - memoryRevision 追踪动作请求依据的会话记忆版本（便于排查上下文不一致）。
 */

/** @typedef {'crashed'|'success'|'waiting'|'running'|'idle'} UiStatus */

/**
 * @typedef {{id: string, chatSessionId: string, actionSessionId: string,
 *   controlSessionId?: string, sessionKind?: 'host'|'logical'}} Live2DWorkspace
 *   chat/action = 两个活动会话；controlSessionId 为只读兼容列（v11 起不再写入）。
 *   sessionKind='logical' 表示 sessionId 是逻辑标识而非宿主会话 id（R1 裁决）。
 */

/** @typedef {{workspaceId: string, chatSessionId: string, summary: string, recentMessages: Array<{role: 'user'|'assistant', content: string, timestamp: number}>, revision: number}} SessionMemory */

/** @typedef {{status: UiStatus, message?: string, errorCode?: string, updatedAt: number, revision: number}} UiStatusSnapshot */

/** @typedef {{requestId: string, workspaceId: string, controlSessionId: string, action: string, args: Record<string, unknown>, priority: number, timeoutMs: number, createdAt: number, memoryRevision: number}} ModelActionRequest */

/** @typedef {'queued'|'running'|'completed'|'failed'|'cancelled'|'interrupted'} ActionState */

/** @typedef {{requestId: string, state: ActionState, startedAt?: number, completedAt?: number, error?: string, result?: unknown}} ActionReceipt */

/** 会话记忆注入：最近消息上限（裁决书 §五，最多 10 条）。 */
export const MAX_RECENT_MESSAGES = 10;

/** 滚动摘要字节上限（裁决书/设计契约 §0.2，2KB，按 UTF-8 字节截断）。 */
export const SUMMARY_MAX_BYTES = 2048;

/** 合法记忆角色。 */
export const MEMORY_ROLES = Object.freeze(['user', 'assistant']);
