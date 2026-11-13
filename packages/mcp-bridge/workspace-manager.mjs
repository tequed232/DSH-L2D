/**
 * Live2D Workspace Manager（PR-A B01-B03；PR-1 双会话改造）。
 *
 * 职责：ensureWorkspace() —— 首次创建 / 重复恢复，返回
 * {id, chatSessionId, actionSessionId}（恰好两个**活动**会话）。
 *
 * 双会话语义（Dual-Session Bridge Router §四）：
 *   - chat   ：用户对话，可提出结构化动作请求，不写 Nodegraph；
 *   - action ：按需写 Nodegraph，默认 idle，不接完整聊天历史；
 *   - control：**只读兼容列**，v11 起不再创建、不再复用（旧库值原样保留）。
 *
 * 依赖注入纪律（设计契约 §0.1）：Registry / SessionController 不直接 import
 * 宿主或 A2A 客户端——agentClient 由调用方注入（真实 A2A 客户端待宿主接线，
 * 测试注入 fake 不发真 HTTP）。接口形状：
 *   agentClient.acquireWorkspace({pluginId})          → {workspaceId}
 *   agentClient.createSession({workspaceId, key, title}) → {sessionId}
 *   agentClient.kind                                  → 'host' | 'logical-placeholder'（可选）
 *
 * 会话真实性（R1 裁决：接受逻辑会话降级）：
 *   当注入的是占位客户端（kind === 'logical-placeholder'）时，返回的 sessionId 是
 *   **逻辑会话标识**（形如 `local-dsh-l2d:action`），不是宿主会话 id。此时
 *   workspace.sessionKind === 'logical'，验收口径按「2 逻辑会话 + 1 真实宿主会话」
 *   执行，不得据此宣称"恰好两个宿主会话"。
 *
 * 注：设计契约 §0.1 提到 workspace-agent.mjs 的 acquireWorkspaceAgent——经仓库
 * 实读该函数尚不存在，故本层只认注入接口，不伪造已接通（与裁决书 §九
 * injectControlContext 同一纪律）。
 */

import {
  findBridgeWorkspace, findBridgeWorkspaceByWorkspaceId, upsertBridgeWorkspace,
  updateBridgeWorkspaceSession, claimBridgeWorkspaceSession,
} from '../dsh-l2d-db/src/bridge-repo.mjs';

/** 活动会话键（chat + action）。control 是只读兼容列，不在此表。 */
const SESSION_KEYS = Object.freeze({ chat: 'chat', action: 'action' });
/** 旧键：只写兼容列，不再用于新建活动会话。 */
const LEGACY_CONTROL_KEY = 'model-control';
const VALID_KEYS = new Set([SESSION_KEYS.chat, SESSION_KEYS.action, LEGACY_CONTROL_KEY]);

const COLUMN_BY_KEY = Object.freeze({
  chat: 'chatSessionId',
  action: 'actionSessionId',
  [LEGACY_CONTROL_KEY]: 'controlSessionId',
});

/**
 * Registry 薄层：findByPlugin = 查 bridge_workspaces；create = A2A 取 workspaceId
 * 后落库（失败不落库，原子）。PRIMARY KEY 复用 = 并发导入防重。
 */
export class WorkBuddyWorkspaceRegistry {
  /** @param {{db: object, agentClient: object}} deps */
  constructor({ db, agentClient }) {
    if (!db) throw new Error('WorkBuddyWorkspaceRegistry: db 必填');
    if (!agentClient || typeof agentClient.acquireWorkspace !== 'function') {
      throw new Error('WorkBuddyWorkspaceRegistry: agentClient.acquireWorkspace 必填（注入接口）');
    }
    this.db = db;
    this.agentClient = agentClient;
  }

  /** @returns {Promise<Live2DWorkspace|null>} null = 首次 import（B01） */
  async findByPlugin(pluginId) {
    const row = findBridgeWorkspace(this.db, pluginId);
    if (!row) return null;
    return {
      id: row.workspaceId,
      chatSessionId: row.chatSessionId,
      actionSessionId: row.actionSessionId,
      /** @deprecated 只读兼容列（旧 Control Session），不参与活动会话计数。 */
      controlSessionId: row.controlSessionId,
    };
  }

  /** create 失败不落库（先 A2A 后 INSERT，原子）。@returns {Promise<{id: string}>} */
  async create({ pluginId }) {
    const acquired = await this.agentClient.acquireWorkspace({ pluginId });
    const workspaceId = String(acquired && acquired.workspaceId || '');
    if (!workspaceId) throw new Error('WorkBuddyWorkspaceRegistry: agentClient 未返回 workspaceId');
    upsertBridgeWorkspace(this.db, { pluginId, workspaceId });
    return { id: workspaceId };
  }
}

/**
 * SessionController 薄层：本地行已存 id 直接复用；否则 A2A createSession 后
 * 抢占式回填（CAS）。upsert 幂等 = 并发导入防重（B03 恰好两会话）。
 *
 * 并发控制两道：
 *   1. 进程内 pending 去重：同 (workspaceId, key) 的并发调用共享同一个 Promise，
 *      不会各建一个会话；
 *   2. DB 级 CAS：跨进程并发时，claimBridgeWorkspaceSession 的 UPDATE ... WHERE 空
 *      只有一条生效，败者回读既有 id 复用（多建的会话 id 经 orphanSessionId 上报，
 *      不静默吞掉）。
 */
export class WorkBuddySessionController {
  /** @param {{db: object, agentClient: object}} deps */
  constructor({ db, agentClient }) {
    if (!db) throw new Error('WorkBuddySessionController: db 必填');
    if (!agentClient || typeof agentClient.createSession !== 'function') {
      throw new Error('WorkBuddySessionController: agentClient.createSession 必填（注入接口）');
    }
    this.db = db;
    this.agentClient = agentClient;
    /** @type {Map<string, Promise<{id: string, reused: boolean}>>} */
    this.pending = new Map();
  }

  /**
   * @param {{workspaceId: string, key: 'chat'|'action'|'model-control', title: string}} input
   * @returns {Promise<{id: string, reused: boolean, orphanSessionId?: string}>}
   */
  async ensureSession(input) {
    const key = input && input.key;
    if (!VALID_KEYS.has(key)) {
      throw new Error(`ensureSession: key 必须是 'chat' | 'action'（兼容 'model-control'），收到 ${String(key)}`);
    }
    // 表主键是 plugin_id，这里拿到的是 A2A workspaceId → 反查
    const row = findBridgeWorkspaceByWorkspaceId(this.db, input.workspaceId);
    if (!row) throw new Error(`ensureSession: 工作区未注册 workspace_id=${input.workspaceId}`);
    const field = COLUMN_BY_KEY[key];
    const existing = String(row[field] || '');
    if (existing) return { id: existing, reused: true };

    const dedupeKey = `${input.workspaceId}\u0000${key}`;
    const inflight = this.pending.get(dedupeKey);
    if (inflight) return inflight;

    const task = this._createAndClaim({ row, key, title: input.title }).finally(() => {
      this.pending.delete(dedupeKey);
    });
    this.pending.set(dedupeKey, task);
    return task;
  }

  /** @private */
  async _createAndClaim({ row, key, title }) {
    const created = await this.agentClient.createSession({
      workspaceId: row.workspaceId, key, title: String(title || ''),
    });
    const sessionId = String(created && created.sessionId || '');
    if (!sessionId) throw new Error('WorkBuddySessionController: agentClient 未返回 sessionId');

    const claim = claimBridgeWorkspaceSession(this.db, row.pluginId, key, sessionId);
    if (!claim) throw new Error(`ensureSession: 工作区行消失 plugin_id=${row.pluginId}`);
    if (claim.claimed) return { id: sessionId, reused: false };
    // 跨进程竞态：本进程"查空"之后、CAS 之前别人已写入。
    // 复用赢家 id；本次新建 id 上报为孤儿，由调用方决定清理（不静默丢弃）。
    return { id: claim.sessionId, reused: true, orphanSessionId: sessionId };
  }
}

/** 装配层：ensureWorkspace 覆盖首次创建与重复恢复（B01/B02）。 */
export class Live2DWorkspaceManager {
  /** @param {{registry: WorkBuddyWorkspaceRegistry, sessions: WorkBuddySessionController}} deps */
  constructor({ registry, sessions }) {
    if (!registry) throw new Error('Live2DWorkspaceManager: registry 必填');
    if (!sessions) throw new Error('Live2DWorkspaceManager: sessions 必填');
    this.registry = registry;
    this.sessions = sessions;
  }

  /**
   * 保证恰好两个活动会话（chat + action）。
   * @returns {Promise<{id: string, chatSessionId: string, actionSessionId: string,
   *   controlSessionId: string, sessionKind: 'host'|'logical'}>}
   */
  async ensureWorkspace(pluginId) {
    let workspace = await this.registry.findByPlugin(pluginId);
    if (!workspace) {
      const created = await this.registry.create({ pluginId });
      workspace = { id: created.id, chatSessionId: '', actionSessionId: '', controlSessionId: '' };
    }
    // 顺序创建（不并行）：chat 先于 action，便于宿主侧审计会话先后顺序；
    // 幂等由 ensureSession 的"已存在直接复用"保证，重复 import 不会重建。
    const chat = await this.sessions.ensureSession({
      workspaceId: workspace.id, key: SESSION_KEYS.chat, title: 'Live2D Chat',
    });
    const action = await this.sessions.ensureSession({
      workspaceId: workspace.id, key: SESSION_KEYS.action, title: 'Live2D Action',
    });
    const kind = this.registry.agentClient && this.registry.agentClient.kind;
    return {
      id: workspace.id,
      chatSessionId: chat.id,
      actionSessionId: action.id,
      // 只读兼容：旧行可能仍有值；新库恒为空串。
      controlSessionId: workspace.controlSessionId || '',
      sessionKind: kind === 'logical-placeholder' ? 'logical' : 'host',
    };
  }
}

export { SESSION_KEYS, LEGACY_CONTROL_KEY, updateBridgeWorkspaceSession };
