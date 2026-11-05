/**
 * Live2D MCP Bridge 总装（PR-A 骨架，B01-B04 覆盖；PR-B/C 接线状态与动作通道）。
 *
 * 三原则：工作区隔离 / 状态解耦 / 执行串行（设计契约 v1）。
 * 本文件不 import 宿主模块——全部依赖经构造注入（onPluginImport 由宿主装配）。
 */


/**
 * @param {import('./workspace-manager.mjs').Live2DWorkspaceManager} deps.workspaceManager
 * @param {import('./session-memory.mjs').SessionMemoryInjector} [deps.memory]
 * @param {import('./action-queue.mjs').ModelActionQueue} [deps.queue] PR-C：动作队列（未注入则动作通道不可用，不伪报）
 * @param {import('./action-executor.mjs').HttpActionExecutor} [deps.executor] 注入引用（状态上报/诊断用）
 * @param {import('@dsh/db').BridgeActionsRepo} [deps.actionsRepo] bridge-actions-repo 绑定 db 后的门面对象（可选）
 * @param {string} deps.pluginId
 */
export class Live2DMCPBridge {
  constructor({ workspaceManager, memory = null, pluginId, queue = null, executor = null, actionsRepo = null }) {
    if (!workspaceManager) throw new Error('Live2DMCPBridge: workspaceManager 必填');
    if (!pluginId) throw new Error('Live2DMCPBridge: pluginId 必填');
    this.workspaceManager = workspaceManager;
    this.memory = memory; // 可选：未注入时不伪报记忆已接通（initialize 内守卫）
    this.pluginId = pluginId;
    this.queue = queue; // 可选：未注入时 enqueueAction 明确拒绝（不静默降级）
    this.executor = executor;
    this.actionsRepo = actionsRepo;
    this.workspace = null;
    this.initialized = false;
  }

  /** initialize：ensureWorkspace + 记忆快照 + 重启恢复 + 注入控制上下文引用。可重入（幂等）。 */
  async initialize() {
    if (this.initialized) return this.workspace;
    this.workspace = await this.workspaceManager.ensureWorkspace(this.pluginId);

    // 重启恢复（B17）：未完成动作全部 interrupted，不重放——重启后 Runtime 状态未知。
    if (this.queue) {
      const recovered = this.queue.recoverFromRestart();
      if (recovered > 0) {
        // 依存在 queue.recoverFromRestart 的返回值，不在此伪报恢复细节
        this.lastRecoveryCount = recovered;
      }
    }

    // Chat → Bridge 的记忆读取能力：PR-A 用本地镜像；未注入 source 时不伪报已接通。
    if (this.memory) {
      const snapshot = await this.memory.snapshot(this.workspace.id, this.workspace.chatSessionId);
      await this.injectControlContext(snapshot);
    }
    this.initialized = true;
    return this.workspace;
  }

  /**
   * ⚠ 宿主适配点（有意留空，不伪造已接通）：
   * 应调用 DSH 原生 Session Controller 把「摘要 + memory revision」作为上下文
   * 引用注入 Model Control 会话——不复制完整 Chat 历史。真实 A2A/宿主签名
   * 待接线（侦察确认 controller 无现成上下文注入 API，见侦察报告 §1）。
   */
  async injectControlContext(memory) {
    void memory;
    return { wired: false, reason: 'host-session-context-api-pending' };
  }

  /**
   * 动作入队（PR-C，执行串行原则）。queue 未注入时明确拒绝，不伪报已受理。
   * workspaceId / controlSessionId 由桥补齐（workspace 隔离原则），调用方不可伪造。
   */
  async enqueueAction(request) {
    if (!this.queue) throw new Error('enqueueAction: action queue 未注入（PR-C 接线缺失），拒绝执行');
    if (!this.initialized || !this.workspace) throw new Error('enqueueAction: bridge 未 initialize');
    if (!request || typeof request !== 'object') throw new Error('enqueueAction: request 必填');
    if (!request.requestId || typeof request.action !== 'string' || !request.action) {
      throw new Error('enqueueAction: requestId / action 必填');
    }
    return this.queue.enqueue({
      ...request,
      workspaceId: this.workspace.id,
      controlSessionId: this.workspace.controlSessionId,
    });
  }

  /** l2d_action_status / l2d_action_cancel 的 deps 装配（registerLive2DTools 消费）。 */
  makeActionToolDeps(validateAction) {
    if (!this.queue) throw new Error('makeActionToolDeps: action queue 未注入');
    const bridge = this;
    return {
      workspace: this.workspace,
      validateAction,
      enqueue: (request) => bridge.enqueueAction(request),
      getStatus: async (requestId) => {
        const row = bridge.actionsRepo ? bridge.actionsRepo.findById(requestId) : null;
        const queueState = bridge.queue.getState();
        if (!row) {
          return {
            receipt: queueState.activeRequestId === requestId
              ? { requestId, state: 'running' }
              : null,
            queue: queueState,
          };
        }
        return { receipt: { requestId, state: row.state, error: row.error ?? undefined, result: row.result ?? undefined }, queue: queueState };
      },
      cancel: (requestId) => bridge.queue.cancel(requestId),
    };
  }

  /** 插件卸载：释放运行时资源，不删除工作区历史（裁决书 §四）。 */
  async dispose() {
    if (this.queue) await this.queue.dispose(); // cancel 活动项 + pending 全部 cancelled 回执
    this.initialized = false;
    this.workspace = null;
  }
}

/** 插件导入钩子（裁决书 §四签名；宿主在 apply() 生命周期调用）。 */
export async function onPluginImport(bridge) {
  await bridge.initialize();
  return bridge.workspace;
}

/** 插件卸载钩子：释放运行时资源，不删除工作区历史。 */
export async function onPluginDispose(bridge) {
  await bridge.dispose();
}
