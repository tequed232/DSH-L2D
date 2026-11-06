/**
 * DSH-L2D 恢复状态机（P0 修复）——纯函数规格模块。
 *
 * overlay.js 内嵌同语义实现（overlay 是 classic script，无法 import 本模块；
 * 本模块是状态机语义的**规格源**，测试直接驱动这里的实现，另以静态断言保证
 * overlay.js 内嵌实现的关键钩子未被后续重构删除）。
 *
 * 状态图：
 *   initializing → loading → ready
 *                  loading → retry_wait → loading（自动重试，1s/3s/8s ×3）
 *                  loading → failed（重试耗尽）→ loading（用户手动重试，不限次数）
 *                  failed → model_disabled / module_disabled（用户裁决）
 *
 * 核心原则：模型是可选组件，DSH 是核心宿主。模型失败 ≠ 插件失败 ≠ DSH 失败；
 * 失败态容器收缩 300×300；重试耗尽后停止自动重试，等待用户操作。
 */

export const RECOVERY_STATES = [
  'initializing',
  'loading',
  'ready',
  'retry_wait',
  'failed',
  'model_disabled',
  'module_disabled',
];

export const DEFAULT_RETRY_TIMERS = [1000, 3000, 8000];
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_LOAD_TIMEOUT_MS = 15000;

/** 失败/加载中容器的最大操作范围（用户验收硬指标） */
export const FAILED_CONTAINER_PX = 300;

/** 模组禁用的持久化键（localStorage）：刷新页面后仍保持禁用 */
export const MODULE_DISABLED_KEY = 'dsh-l2d.disabled';

/**
 * 创建恢复控制器（零 DOM，deps 注入副作用）。
 *
 * @param {object} deps
 *   onStateChange(state, info)        状态转换回调（overlay 侧：dataset + CustomEvent）
 *   startAttempt(generation)          发起一轮真实加载（overlay 侧：initRenderer 内核）
 *   schedule(fn, delayMs) -> id       定时器（可注入假时钟）
 *   cancel(id)                        取消定时器
 *   now() -> ms                       时钟（可注入假时钟）
 */
export function createRecoveryController(deps) {
  var state = 'initializing';
  var attempts = 0;
  var generation = 0;
  var timer = null;
  var lastError = null;
  var modelDisabled = false;
  var moduleDisabled = false;
  var opts = {
    maxRetries: deps.maxRetries != null ? deps.maxRetries : DEFAULT_MAX_RETRIES,
    retryTimers: deps.retryTimers || DEFAULT_RETRY_TIMERS,
    loadTimeoutMs: deps.loadTimeoutMs != null ? deps.loadTimeoutMs : DEFAULT_LOAD_TIMEOUT_MS,
  };
  var now = deps.now || function () { return Date.now(); };

  function setState(next, error) {
    if (RECOVERY_STATES.indexOf(next) < 0) {
      throw new Error('unknown recovery state: ' + next);
    }
    state = next;
    lastError = error != null ? error : lastError;
    if (deps.onStateChange) {
      deps.onStateChange(state, { error: lastError, attempts: attempts, generation: generation });
    }
  }

  function isTerminalDisabled() {
    return moduleDisabled || modelDisabled;
  }

  return {
    /** 当前状态/计数快照（测试与宿主自省用） */
    snapshot: function () {
      return {
        state: state,
        attempts: attempts,
        generation: generation,
        lastError: lastError,
        modelDisabled: modelDisabled,
        moduleDisabled: moduleDisabled,
        maxRetries: opts.maxRetries,
        loadTimeoutMs: opts.loadTimeoutMs,
      };
    },

    /** 下一轮加载的代数 id：旧代异步完成不得覆盖新代状态 */
    nextGeneration: function () {
      generation += 1;
      return generation;
    },

    /** 开始一轮加载（含首启）。返回本轮 generation。 */
    beginLoading: function () {
      if (isTerminalDisabled()) return null;
      if (timer != null && deps.cancel) { deps.cancel(timer); timer = null; }
      attempts = 0;
      var gen = this.nextGeneration();
      setState('loading');
      if (deps.startAttempt) deps.startAttempt(gen);
      return gen;
    },

    /** 本轮（generation 匹配的）加载失败：调度自动重试或进入 failed。 */
    reportFailure: function (gen, error) {
      if (gen !== generation) return { ignored: true, reason: 'stale-generation' };
      if (isTerminalDisabled()) return { ignored: true, reason: 'disabled' };
      lastError = error != null ? error : lastError;

      if (attempts >= opts.maxRetries) {
        if (timer != null && deps.cancel) { deps.cancel(timer); timer = null; }
        setState('failed');
        return { done: true, state: 'failed' };
      }

      var timers = opts.retryTimers.length ? opts.retryTimers : DEFAULT_RETRY_TIMERS;
      var delay = timers[Math.min(attempts, timers.length - 1)];
      attempts += 1;
      setState('retry_wait');
      var genNext = this.nextGeneration();
      var self = this;
      timer = deps.schedule(function () {
        timer = null;
        // 重试也是一轮新加载：generation 递增防旧代竞态
        setState('loading');
        if (deps.startAttempt) deps.startAttempt(genNext);
      }, delay);
      return { done: false, retryIn: delay, attempt: attempts, generation: genNext };
    },

    /** 本轮加载成功：计数清零，回到 ready。 */
    reportSuccess: function (gen) {
      if (gen !== generation) return { ignored: true, reason: 'stale-generation' };
      if (timer != null && deps.cancel) { deps.cancel(timer); timer = null; }
      attempts = 0;
      lastError = null;
      setState('ready');
      return { done: true, state: 'ready' };
    },

    /** 用户手动重试（对话框「重新加载 Plugin」）：不限次数，计数重置。 */
    manualRetry: function () {
      if (moduleDisabled) return { ignored: true, reason: 'module-disabled' };
      modelDisabled = false; // 手动重试视为撤回「禁用模型」
      return this.beginLoading();
    },

    /** 用户裁决：禁用当前模型（模组仍可用，DSH 其余功能不受影响）。 */
    disableModel: function () {
      if (timer != null && deps.cancel) { deps.cancel(timer); timer = null; }
      modelDisabled = true;
      setState('model_disabled');
    },

    /** 用户裁决：禁用整个模组（持久化由 overlay 侧写 localStorage）。 */
    disableModule: function () {
      if (timer != null && deps.cancel) { deps.cancel(timer); timer = null; }
      modelDisabled = false;
      moduleDisabled = true;
      setState('module_disabled');
    },

    isModuleDisabled: function () { return moduleDisabled; },
    isModelDisabled: function () { return modelDisabled; },

    /** 宿主重载（刷新页面等）时清定时器。 */
    dispose: function () {
      if (timer != null && deps.cancel) { deps.cancel(timer); timer = null; }
    },
  };
}
