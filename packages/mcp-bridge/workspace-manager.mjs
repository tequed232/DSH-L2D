/**
 * Live2D Workspace Manager（PR-A，B01-B03）。
 *
 * 职责：ensureWorkspace() —— 首次创建 / 重复恢复，返回 {id, chatSessionId,
 * controlSessionId}（恰好两个独立会话）。
 *
 * 依赖注入纪律（设计契约 §0.1）：Registry / SessionController 不直接 import
 * 宿主或 A2A 客户端——agentClient 由调用方注入（真实 A2A 客户端待宿主接线，
 * 测试注入 fake 不发真 HTTP）。接口形状：
 *   agentClient.acquireWorkspace({pluginId})          → {workspaceId}
 *   agentClient.createSession({workspaceId, key, title}) → {sessionId}
 *
 * 注：设计契约 §0.1 提到 workspace-agent.mjs 的 acquireWorkspaceAgent——经仓库
 * 实读该函数尚不存在，故本层只认注入接口，不伪造已接通（与裁决书 §九
 * injectControlContext 同一纪律）。
 */

import {
  findBridgeWorkspace, findBridgeWorkspaceByWorkspaceId, upsertBridgeWorkspace, updateBridgeWorkspaceSession,
} from '../dsh-l2d-db/src/bridge-repo.mjs';

const SESSION_KEYS = Object.freeze({ chat: 'chat', control: 'model-control' });

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
    return { id: row.workspaceId, chatSessionId: row.chatSessionId, controlSessionId: row.controlSessionId };
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
 * SessionController 薄层：本地行已存 id 直接复用；否则 A2A createSession 后回填
 * 对应列。upsert 幂等 = 并发导入防重（B03 恰好两会话）。
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
  }

  /**
   * @param {{workspaceId: string, key: 'chat'|'model-control', title: string}} input
   * @returns {Promise<{id: string, reused: boolean}>}
   */
  async ensureSession(input) {
    const key = input && input.key;
    if (key !== 'chat' && key !== 'model-control') {
      throw new Error(`ensureSession: key 必须是 'chat' | 'model-control'，收到 ${String(key)}`);
    }
    const column = key === 'chat' ? 'chat_session_id' : 'control_session_id';
    // 表主键是 plugin_id，这里拿到的是 A2A workspaceId → 反查
    const row = findBridgeWorkspaceByWorkspaceId(this.db, input.workspaceId);
    if (!row) throw new Error(`ensureSession: 工作区未注册 workspace_id=${input.workspaceId}`);
    const existing = column === 'chat_session_id' ? row.chatSessionId : row.controlSessionId;
    if (existing) return { id: existing, reused: true };

    const created = await this.agentClient.createSession({
      workspaceId: input.workspaceId, key, title: String(input.title || ''),
    });
    const sessionId = String(created && created.sessionId || '');
    if (!sessionId) throw new Error('WorkBuddySessionController: agentClient 未返回 sessionId');
    updateBridgeWorkspaceSession(this.db, row.pluginId, key === 'chat' ? 'chat' : 'control', sessionId);
    return { id: sessionId, reused: false };
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

  /** @returns {Promise<Live2DWorkspace>} */
  async ensureWorkspace(pluginId) {
    let workspace = await this.registry.findByPlugin(pluginId);
    if (!workspace) {
      const created = await this.registry.create({ pluginId });
      workspace = { id: created.id, chatSessionId: '', controlSessionId: '' };
    }
    const [chat, control] = await Promise.all([
      this.sessions.ensureSession({ workspaceId: workspace.id, key: SESSION_KEYS.chat, title: 'Live2D Chat' }),
      this.sessions.ensureSession({ workspaceId: workspace.id, key: SESSION_KEYS.control, title: 'Live2D Model Control' }),
    ]);
    return { id: workspace.id, chatSessionId: chat.id, controlSessionId: control.id };
  }
}
