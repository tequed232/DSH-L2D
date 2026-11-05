/**
 * 会话记忆注入桥（PR-A，B04）。
 *
 * 设计契约 §0.2：A2A 会话历史不可读 → ChatMemorySource 用**本地 bounded 镜像**
 * （后续由 session-event-bus 的 chat_message 事件驱动 + 宿主显式 appendChatTurn），
 * 不伪造宿主读接口。
 *
 * 注入纪律（裁决书 §五）：
 *  - 不注入密码 / Token / 密钥等凭据（appendChatTurn 只做结构存储，凭据过滤由
 *    事件源侧负责——本层不做内容语义过滤，B04 只验证镜像与 revision 语义）；
 *  - 不重复注入已确认历史（快照按 revision 增量消费，PR-B 接线）；
 *  - 不把动作队列历史塞进对话上下文；
 *  - recentMessages 上限 10 条，summary 上限 2KB（UTF-8 字节）。
 */

import { MAX_RECENT_MESSAGES, SUMMARY_MAX_BYTES, MEMORY_ROLES } from './contracts.mjs';

/** 按 UTF-8 字节截断（不切代理对/多字节中间，从尾部回退到字符边界）。 */
function truncateUtf8(str, maxBytes) {
  let s = String(str);
  while (Buffer.byteLength(s, 'utf8') > maxBytes) {
    s = s.slice(0, Math.max(0, Math.floor(s.length * (maxBytes / (Buffer.byteLength(s, 'utf8') + 1)))));
    // 兜底：比例法收敛后仍超限则逐字符回退
    while (s.length > 0 && Buffer.byteLength(s, 'utf8') > maxBytes) s = s.slice(0, -1);
    break;
  }
  return s;
}

/**
 * 本地 bounded 镜像。内存态（有界、可重建），v1 不落盘（设计契约 §2）。
 * @implements {import('./contracts.mjs').SessionMemory}
 */
export class LocalMirrorChatMemorySource {
  constructor() {
    /** @type {Map<string, {summary: string, ring: Array<{role, content, timestamp}>, revision: number}>} */
    this.sessions = new Map();
  }

  #stateOf(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') throw new Error('LocalMirrorChatMemorySource: sessionId 必填');
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { summary: '', ring: [], revision: 0 };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /**
   * 宿主/事件总线写入一轮对话（B04 的驱动点）。
   * @param {string} sessionId
   * @param {'user'|'assistant'} role
   * @param {string} content
   * @returns {{revision: number}} 写入后的记忆版本
   */
  appendChatTurn(sessionId, role, content) {
    if (!MEMORY_ROLES.includes(role)) throw new Error(`appendChatTurn: role 必须是 ${MEMORY_ROLES.join('|')}，收到 ${String(role)}`);
    const text = typeof content === 'string' ? content : String(content ?? '');
    const s = this.#stateOf(sessionId);
    s.ring.push({ role, content: text, timestamp: Date.now() });
    while (s.ring.length > MAX_RECENT_MESSAGES) s.ring.shift();
    s.revision += 1;
    // 滚动摘要：最近轮次拼接（role: content），按字节上限截断
    const lines = s.ring.map((m) => `${m.role}: ${m.content.replace(/\s+/g, ' ').trim()}`);
    s.summary = truncateUtf8(lines.join('\n'), SUMMARY_MAX_BYTES);
    return { revision: s.revision };
  }

  /** @returns {Promise<string>} 滚动摘要（≤2KB；未知会话返回空串） */
  async getSummary(sessionId) {
    return this.sessions.get(sessionId)?.summary ?? '';
  }

  /** @returns {Promise<Array<{role, content, timestamp}>>} 最近 ≤limit 条（缺省 10） */
  async getRecentMessages(sessionId, limit = MAX_RECENT_MESSAGES) {
    const ring = this.sessions.get(sessionId)?.ring ?? [];
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_RECENT_MESSAGES) : MAX_RECENT_MESSAGES;
    return ring.slice(-n).map((m) => ({ ...m }));
  }

  /** @returns {Promise<number>} 单调递增记忆版本（未知会话 0） */
  async getRevision(sessionId) {
    return this.sessions.get(sessionId)?.revision ?? 0;
  }
}

/** 组装受限上下文快照（三项并行取，不复制完整历史）。 */
export class SessionMemoryInjector {
  /** @param {{source: LocalMirrorChatMemorySource}} deps */
  constructor({ source }) {
    if (!source || typeof source.getSummary !== 'function') {
      throw new Error('SessionMemoryInjector: source 必填（ChatMemorySource 注入接口）');
    }
    this.source = source;
  }

  /** @returns {Promise<SessionMemory>} */
  async snapshot(workspaceId, chatSessionId) {
    const [summary, recentMessages, revision] = await Promise.all([
      this.source.getSummary(chatSessionId),
      this.source.getRecentMessages(chatSessionId, MAX_RECENT_MESSAGES),
      this.source.getRevision(chatSessionId),
    ]);
    return { workspaceId, chatSessionId, summary, recentMessages, revision };
  }
}
