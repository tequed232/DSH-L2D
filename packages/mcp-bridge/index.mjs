/**
 * Live2D MCP Bridge 总装（PR-A 骨架，B01-B04 覆盖；PR-B/C 接线状态与动作通道）。
 *
 * 三原则：工作区隔离 / 状态解耦 / 执行串行（设计契约 v1）。
 * 本文件不 import 宿主模块——全部依赖经构造注入（onPluginImport 由宿主装配）。
 */


/**
 * @param {import('./workspace-manager.mjs').Live2DWorkspaceManager} deps.workspaceManager
 * @param {import('./session-memory.mjs').SessionMemoryInjector} [deps.memory]
 * @param {string} deps.pluginId
 */
export class Live2DMCPBridge {
  constructor({ workspaceManager, memory = null, pluginId }) {
    if (!workspaceManager) throw new Error('Live2DMCPBridge: workspaceManager 必填');
    if (!pluginId) throw new Error('Live2DMCPBridge: pluginId 必填');
    this.workspaceManager = workspaceManager;
    this.memory = memory; // 可选：未注入时不伪报记忆已接通（initialize 内守卫）
    this.pluginId = pluginId;
    this.workspace = null;
    this.initialized = false;
  }

  /** initialize：ensureWorkspace + 记忆快照 + 注入控制上下文引用。可重入（幂等）。 */
  async initialize() {
    if (this.initialized) return this.workspace;
    this.workspace = await this.workspaceManager.ensureWorkspace(this.pluginId);

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

  /** 动作入队：PR-C 接线 ModelActionQueue 后启用（执行串行原则）。 */
  async enqueueAction() {
    throw new Error('enqueueAction: action channel 在 PR-C 接线（B10-B18 范围）');
  }

  /** 插件卸载：释放运行时资源，不删除工作区历史（裁决书 §四）。 */
  async dispose() {
    // PR-B：StatusReporter.stop()；PR-C：queue.dispose()（确认 stopAndRelease）。
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
