/**
 * dsh-l2d overlay —— 浏览器侧
 *
 * 以普通 <script> 注入，不使用模块语法。职责：
 *   1. 在 DSH 页面之上叠一层透明角色容器（固定定位、可拖动、不挡主界面）
 *   2. rAF 呼吸/摇摆微动作（后续由 ParamMixer 输出真实参数替换）
 *   3. 演示四态情境（待机 / 问答 / 操作 / 离席）的视觉差异
 *
 * 约束：
 *   - 容器 pointer-events:none，仅角色本体与状态胶囊可交互，避免遮挡 DSH 按钮
 *   - SPA 重渲染可能移除节点，用 MutationObserver 兜底重挂
 *   - 立绘缺失时回退内置 SVG 轮廓，不出现破图
 */
(function () {

  // E2：能力画像预取（/dsh-l2d/capability.json）。失败不致命——l2d_posture 会报 profile-loading。
  try {
    fetch('/dsh-l2d/capability.json', { cache: 'no-store' })
      .then(function (r2) { return r2.ok ? r2.json() : null; })
      .then(function (j2) { if (j2 && j2.controls) window.__L2D_PROFILE__ = j2; })
      .catch(function () { /* 静默：l2d_posture 会显式报 profile-loading */ });
  } catch (e2) { /* 同上 */ }
  'use strict';

  if (window.__DSH_L2D_OVERLAY__) return;

  // 注入 URL 上的 v= 是构建标记：资源地址统一带上它，避免刷新后复用旧脚本。
  var __bootTag = (function () {
    try {
      var src = (document.currentScript && document.currentScript.src) || '';
      var m = src.match(/[?&]v=([^&]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  })();
  function versioned(p) { return __bootTag ? p + (p.indexOf('?') >= 0 ? '&' : '?') + 'v=' + __bootTag : p; }
  window.__DSH_L2D_OVERLAY__ = true;

  // 消费者租约（M1-d3）：页面自生成身份，同版本双页靠它区分（__bootTag 不可区分）。
  // 页面刷新/重开生成新 id → 服务端自然走接管流程，无遗留状态。
  var __aiConsumerId = (function () {
    try {
      return 'c-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
    } catch (e) {
      return 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    }
  })();
  // /ai/poll 响应下发的租约凭证：result 提交必须附带，接管后旧 token 即刻作废
  var __aiLeaseToken = '';
  var __aiLeaseEpoch = 0;

  // 说明：App 壳（dsh-app://）注入时 readyState 已是 complete，bootOverlay 会走
  // setTimeout 宏任务；但 ensureMounted / startAiPoll 等还有同步调用路径。agentLink 若
  // 只在 IIFE 后段声明，会以 var 提升的 undefined 被读到，startAgentPoll 抛
  // "Cannot read properties of undefined (reading 'timer')"，并让下一行
  // initEmotionSensors() 永远不执行——鼠标/注视跟随就整体不绑定（App 页眼追失效的根因）。
  var agentLink = { state: 'unknown', prevState: '', lastAt: 0, timer: 0, lastSpokeAt: 0 };
  // 设置热更新：外部 PUT /dsh-l2d/settings.json 后，页面需要自己发现变化（overlay 不再整份覆盖设置）
  var settingsWatch = { timer: 0, lastEyeFollow: null };
  var gazeNeutralTimer = 0;

  // ---- 环境感知层（输入框追踪 / 挂机 / 回归）--------------------------------
  // 与 agentLink 同理：bootOverlay 可能在 IIFE 尾部赋值前被调度，这里必须提前初始化。
  // 目标：只产出低成本的原始交互信号（focus/typing/activity/visibility），
  // 由人设规划层（宿主侧）决定要不要演；本层不调工具、不烧 LLM。
  var ENV_AWAY_AFTER_MS = 60000; // 离开 60s 才进 away
  var ENV_TICK_MS = 1000; // 环境层心跳
  var ENV_TYPING_HOLD_MS = 4000; // 打字后 4s 内仍算「问答中」
  var ENV_WORK_HOLD_MS = 10000; // 键盘活动后 10s 内算「操作电脑」
  var ENV_REVERSE_EVENT_URL = '/dsh-l2d/reverse/event'; // 环境事件 → 宿主反向桥
  var ENV_PRESENCE_MIN_MS = 1000; // presence 节流
  var ENV_INPUT_MIN_MS = 200; // user-input 节流
  var ENV_HEARTBEAT_MS = 10000; // 可见时每 10s 一次心跳
  var ENV_INPUT_SELECTOR = [
    'textarea',
    'input[type="text"]',
    'input[type="search"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[role="textbox"]'
  ].join(',');
  var env = {
    bound: false,
    away: false,
    awaySince: 0,
    lastActivityAt: Date.now(),
    lastKeyAt: 0,
    lastTypingAt: 0,
    lastPointerAt: 0,
    lastRestoreAt: 0,
    hiddenAt: 0,
    inputEl: null,
    inputRect: null,
    inputGazeOn: false,
    inputFocusedAt: 0,
    lastAimAt: 0,
    tickTimer: 0,
    wanderTimer: 0,
    manualUntil: 0,
    lastStateAt: 0,
    publishAt: 0,
    lastInputEventAt: 0,
    lastPresencePostAt: 0,
    lastInputPostAt: 0,
    lastHeartbeatAt: 0,
    pendingPresence: null
  };

  var ROOT_ID = 'dsh-l2d-root';
  var STORAGE_KEY = 'dsh-l2d.overlay.v1';
  var STATES = ['idle', 'conversation', 'work', 'away'];
  var LABEL = { idle: '待机', conversation: '问答中', work: '操作电脑', away: '离席' };
  var BUBBLE = {
    idle: ['……', '在等你', '有点无聊', '要不要聊会'],
    conversation: ['我在听', '嗯？', '让我想想', '这个我知道'],
    work: ['又在写代码', '加油', '要不要休息下', '这行有点长'],
    away: ['去忙吧', '我眯一会儿', 'zzZ', '回来叫我']
  };

  var prefs = { state: 'idle', left: null, top: null, bodyType: 0 };
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (saved && STATES.indexOf(saved.state) >= 0) prefs.state = saved.state;
    if (typeof saved.left === 'number') prefs.left = saved.left;
    if (typeof saved.top === 'number') prefs.top = saved.top;
    if (Number.isInteger(saved.bodyType) && saved.bodyType >= 0 && saved.bodyType <= 2) prefs.bodyType = saved.bodyType;
  } catch (e) { /* 隐私模式忽略 */ }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (e) { /* ignore */ }
  }

  var STYLE_TEXT = [
    // 用 transform 定位而不是 left/top：拖拽时只改合成层偏移，不触发布局重排。
    // will-change 提前把图层独立出来，避免拖动过程中反复提升/降级。
    // 颜色、字号、间距、圆角、阴影、动效都走 ui-tokens.css，这里只写结构。
    '#dsh-l2d-root,.l2d-menu,.l2d-panel{font-family:var(--dsh-font-sans);color:var(--dsh-ink);}',
    '#' + ROOT_ID + '{position:fixed;left:0;top:0;width:320px;height:400px;',
    'z-index:var(--dsh-z-overlay,2147483000);pointer-events:none;user-select:none;-webkit-user-select:none;',
    'will-change:transform;transform:translate3d(0,0,0);contain:layout style;}',
    '#' + ROOT_ID + ' .l2d-body{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;',
    // 角色盒不再拦事件：交互全部由 window 捕获层 + 渲染包 alpha 命中判定接管，
    // 这样空白处鼠标直接透过到下层页面（点 DSH 按钮等）。
    'pointer-events:none;cursor:grab;transition:filter var(--dsh-dur) var(--dsh-ease),opacity var(--dsh-dur) var(--dsh-ease);}',
    '#' + ROOT_ID + ' .l2d-body.dragging{cursor:grabbing;}',
    '#' + ROOT_ID + ' .l2d-canvas{width:100%;height:100%;display:block;pointer-events:none;}',
    '#' + ROOT_ID + ' .l2d-body img{width:100%;height:100%;object-fit:contain;',
    'filter:var(--dsh-shadow-drop);',
    'transition:transform var(--dsh-dur) var(--dsh-ease);will-change:transform;pointer-events:none;}',
    '#' + ROOT_ID + ' .l2d-body:hover img{margin-bottom:var(--dsh-space-1);}',
    '#' + ROOT_ID + ' .l2d-placeholder{width:64%;height:64%;margin-bottom:var(--dsh-space-6);',
    'border-radius:46% 46% 42% 42%;background:var(--dsh-accent-soft);}',
    '#' + ROOT_ID + ' .l2d-chip{position:absolute;left:50%;bottom:auto;transform:translateX(-50%);',
    'top:calc(-1 * var(--dsh-control-sm) - var(--dsh-space-1));',
    'pointer-events:auto;cursor:pointer;padding:var(--dsh-space-1) var(--dsh-space-3);border-radius:var(--dsh-radius-full);',
    'font:var(--dsh-text-xs);font-weight:500;white-space:nowrap;',
    'background:var(--dsh-surface);color:var(--dsh-ink-muted);border:1px solid var(--dsh-line);',
    'transition:background var(--dsh-dur-fast) var(--dsh-ease),color var(--dsh-dur-fast) var(--dsh-ease);}',
    '#' + ROOT_ID + ' .l2d-chip:hover{background:var(--dsh-surface-raised);color:var(--dsh-ink);}',
    '#' + ROOT_ID + ' .l2d-bubble{position:absolute;right:0;bottom:calc(100% + var(--dsh-space-2));max-width:200px;',
    'padding:var(--dsh-space-2) var(--dsh-space-3);',
    'border-radius:var(--dsh-radius-lg);',
    'font:var(--dsh-text-sm);',
    'background:var(--dsh-bubble-bg);color:var(--dsh-bubble-ink);box-shadow:var(--dsh-shadow-2);',
    'opacity:0;transform:translateY(var(--dsh-space-2));transform-origin:bottom right;',
    'transition:opacity var(--dsh-dur) var(--dsh-ease),transform var(--dsh-dur) var(--dsh-ease);pointer-events:none;}',
    '#' + ROOT_ID + ' .l2d-bubble.show{opacity:1;transform:translateY(0);}',
    '#' + ROOT_ID + ' .l2d-bubble .price-up{color:var(--dsh-bubble-up);font-weight:600;}',
    '#' + ROOT_ID + ' .l2d-bubble .price-down{color:var(--dsh-bubble-down);font-weight:600;}',
    '#' + ROOT_ID + ' .l2d-bubble .price-sub{display:block;font:var(--dsh-text-xs);color:var(--dsh-bubble-muted);}',
    '#' + ROOT_ID + ' .l2d-price{position:absolute;left:50%;top:calc(100% + var(--dsh-space-2));transform:translateX(-50%);',
    'max-width:min(360px,calc(100vw - var(--dsh-space-5)));padding:var(--dsh-space-2) var(--dsh-space-3);',
    'border-radius:var(--dsh-radius-lg);font:var(--dsh-text-xs);white-space:nowrap;',
    'background:var(--dsh-surface);color:var(--dsh-ink);border:1px solid var(--dsh-line);',
    'box-shadow:var(--dsh-shadow-2);opacity:0;transition:opacity var(--dsh-dur) var(--dsh-ease);pointer-events:none;}',
    '#' + ROOT_ID + ' .l2d-price.show{opacity:1;}',
    '#' + ROOT_ID + ' .l2d-price .price-up{color:var(--dsh-up);font-weight:600;}',
    '#' + ROOT_ID + ' .l2d-price .price-down{color:var(--dsh-down);font-weight:600;}',
    '#' + ROOT_ID + ' .l2d-price .price-sub{display:block;font:var(--dsh-text-xs);color:var(--dsh-ink-muted);}',
    '.l2d-menu{position:fixed;z-index:var(--dsh-z-menu,2147483100);min-width:176px;padding:var(--dsh-space-1);',
    'border-radius:var(--dsh-radius-lg);background:var(--dsh-surface);color:var(--dsh-ink);pointer-events:auto;',
    'box-shadow:var(--dsh-shadow-2);border:1px solid var(--dsh-line);display:none;flex-direction:column;}',
    '.l2d-menu.open{display:flex;}',
    '.l2d-menu button{border:none;background:transparent;color:var(--dsh-ink);text-align:left;',
    'padding:var(--dsh-space-2) var(--dsh-space-3);border-radius:var(--dsh-radius-md);font:var(--dsh-text-sm);cursor:pointer;}',
    '.l2d-menu button:hover{background:var(--dsh-hover);}',
    '.l2d-menu .l2d-menu-title{padding:var(--dsh-space-1) var(--dsh-space-3);font:var(--dsh-text-xs);color:var(--dsh-ink-muted);}',
    '.l2d-qc{display:flex;flex-direction:column;gap:var(--dsh-space-1);padding:var(--dsh-space-1) var(--dsh-space-2) var(--dsh-space-2);}',
    '.l2d-qc-input{box-sizing:border-box;width:100%;max-height:120px;resize:none;',
    'padding:var(--dsh-space-2);border-radius:var(--dsh-radius-md);background:var(--dsh-surface);',
    'color:var(--dsh-ink);font:var(--dsh-text-sm);border:1px solid var(--dsh-line);overflow-y:auto;}',
    '.l2d-qc-input:focus{outline:none;border-color:var(--dsh-accent);}',
    '.l2d-qc-input::placeholder{color:var(--dsh-ink-muted);}',
    '.l2d-qc-send{align-self:flex-end;}',
    '.l2d-qc-hint{font:var(--dsh-text-xs);color:var(--dsh-ink-muted);padding:0 var(--dsh-space-2);}',
    '.l2d-logpanel{position:fixed;right:var(--dsh-space-3);top:var(--dsh-space-3);width:280px;height:360px;',
    'box-sizing:border-box;display:none;flex-direction:column;pointer-events:auto;',
    'border-radius:var(--dsh-radius-lg);background:var(--dsh-surface);color:var(--dsh-ink);',
    'border:1px solid var(--dsh-line);box-shadow:var(--dsh-shadow-2);z-index:var(--dsh-z-panel,2147483200);}',
    '.l2d-logpanel.open{display:flex;}',
    '.l2d-logpanel-head{display:flex;align-items:center;justify-content:space-between;',
    'padding:var(--dsh-space-1) var(--dsh-space-2);border-bottom:1px solid var(--dsh-line);}',
    '.l2d-logpanel-head button{border:1px solid var(--dsh-line);background:transparent;color:var(--dsh-ink);',
    'padding:2px var(--dsh-space-2);border-radius:var(--dsh-radius-md);font:var(--dsh-text-xs);cursor:pointer;}',
    '.l2d-logpanel-head button:hover{background:var(--dsh-hover);}',
    '.l2d-logpanel-body{flex:1;min-height:0;overflow-y:auto;margin:0;padding:var(--dsh-space-1) var(--dsh-space-2);',
    'font-family:var(--dsh-font-mono);font-size:11px;line-height:1.7;}',
    '.l2d-logline{white-space:nowrap;}',
    '.l2d-yandere-fx{position:fixed;inset:0;pointer-events:none;z-index:2147483200;',
    'background:radial-gradient(ellipse at center,rgba(0,0,0,0) 38%,rgba(45,0,14,.6) 100%);',
    'opacity:0;transition:opacity .7s;}',
    '.l2d-yandere-fx.on{opacity:1;}',
    // ---- P0 修复（模型加载失败）：故障恢复状态机样式 ----
    // loading/retry_wait：300×300 收缩（用户验收硬指标）；failed：进一步收缩为
    // 48×48 迷你徽标——报错处理整体迁入浏览器画中画（Document PiP）独立窗口，
    // 页面空间完全让出（用户 2026-11-06 裁决：桌宠占位不得继续压在页面上）。
    '#' + ROOT_ID + '[data-l2d-state="loading"],' +
    '#' + ROOT_ID + '[data-l2d-state="retry_wait"]{' +
    'width:300px !important;height:300px !important;max-width:300px !important;max-height:300px !important;overflow:hidden;}',
    '#' + ROOT_ID + '[data-l2d-state="failed"]{' +
    'width:48px !important;height:48px !important;max-width:48px !important;max-height:48px !important;overflow:visible;pointer-events:none;}',
    '#' + ROOT_ID + '[data-l2d-state="failed"] .l2d-canvas,' +
    '#' + ROOT_ID + '[data-l2d-state="failed"] .l2d-body img,' +
    '#' + ROOT_ID + '[data-l2d-state="failed"] .l2d-placeholder,' +
    '#' + ROOT_ID + '[data-l2d-state="failed"] .l2d-chip,' +
    '#' + ROOT_ID + '[data-l2d-state="failed"] .l2d-gear,' +
    '#' + ROOT_ID + '[data-l2d-state="failed"] .l2d-bubble,' +
    '#' + ROOT_ID + '[data-l2d-state="failed"] .l2d-price,' +
    '#' + ROOT_ID + '[data-l2d-state="failed"] .l2d-body{display:none !important;}',
    // 迷你徽标：failed 态唯一保留的页内元素（48×48，不透明、可点击）。
    // 点击 = user gesture → Document PiP requestWindow 必有 transient activation。
    '#' + ROOT_ID + ' .l2d-mini-badge{display:none;width:48px;height:48px;box-sizing:border-box;' +
    'border-radius:50%;border:1px solid #b45309;background:#431407;color:#fbbf24;' +
    'font-size:22px;line-height:46px;text-align:center;cursor:pointer;pointer-events:auto;padding:0;}' +
    '#' + ROOT_ID + ' .l2d-mini-badge:hover{background:#5c1d09;}' +
    '#' + ROOT_ID + '[data-l2d-state="failed"] .l2d-mini-badge{display:block;}',
    '#' + ROOT_ID + '[data-l2d-state="model_disabled"] .l2d-canvas,' +
    '#' + ROOT_ID + '[data-l2d-state="model_disabled"] .l2d-body img,' +
    '#' + ROOT_ID + '[data-l2d-state="model_disabled"] .l2d-placeholder{display:none !important;}',
    '#' + ROOT_ID + '.away .l2d-body{filter:grayscale(.55) brightness(.72);opacity:.8;}',
    '#' + ROOT_ID + '.conversation .l2d-chip{background:var(--dsh-accent);color:var(--dsh-on-accent);',
    'border-color:transparent;}',
    '#' + ROOT_ID + '.work .l2d-chip{background:var(--dsh-accent-soft);color:var(--dsh-on-accent-soft);',
    'border-color:transparent;}',
    '#' + ROOT_ID + ' .l2d-gear{position:absolute;right:0;width:var(--dsh-control-sm);height:var(--dsh-control-sm);',
    'top:calc(-1 * var(--dsh-control-sm) - var(--dsh-space-1));border-radius:var(--dsh-radius-full);',
    'display:grid;place-items:center;pointer-events:auto;cursor:pointer;border:1px solid var(--dsh-line);',
    'background:var(--dsh-surface);color:var(--dsh-ink);font:var(--dsh-text-sm);line-height:1;opacity:0;',
    'transition:opacity var(--dsh-dur-fast) var(--dsh-ease),background var(--dsh-dur-fast) var(--dsh-ease);}',
    '#' + ROOT_ID + ':hover .l2d-gear{opacity:1;}',
    '#' + ROOT_ID + ' .l2d-gear:hover{background:var(--dsh-surface-raised);}',
    // 设置面板＝响应式浮动窗口：标题栏拖拽、八向缩放、最大化/边缘吸附、四档断点、
    // 几何记忆（{maximized, geometry, previousGeometry, collapsed}）。层级靠位置与字重表达，
    // 仅一层统一高度 shadow-2；禁 transform:scale 整体缩放，断点用 matchMedia + 容器查询。
    '.l2d-panel{position:fixed;left:0;top:0;width:340px;height:auto;box-sizing:border-box;',
    'container-type:inline-size;',
    'border-radius:var(--dsh-radius-lg);',
    'background:var(--dsh-surface);color:var(--dsh-ink);pointer-events:auto;',
    'box-shadow:var(--dsh-shadow-2);border:1px solid var(--dsh-line);',
    'font:var(--dsh-text-sm);display:none;flex-direction:column;',
    'z-index:var(--dsh-z-panel,2147483200);}',
    '.l2d-panel.open{display:flex;}',
    '.l2d-panel.collapsed{height:auto !important;}',
    '.l2d-panel.maximized{border-radius:0;}',
    '.l2d-panel.fullscreen{left:0 !important;top:0 !important;width:100% !important;height:100% !important;',
    'max-width:none !important;border-radius:0;}',
    '.l2d-panel.fullscreen .l2d-panel-head{cursor:default;}',
    '.l2d-panel-head{display:flex;align-items:center;gap:var(--dsh-space-1);flex:none;',
    'padding:var(--dsh-space-2) var(--dsh-space-2) var(--dsh-space-2) var(--dsh-space-4);',
    'border-bottom:1px solid var(--dsh-line);cursor:grab;touch-action:none;',
    'user-select:none;-webkit-user-select:none;}',
    '.l2d-panel-head:active{cursor:grabbing;}',
    '.l2d-panel-head h4{margin:0;font:var(--dsh-text-label);flex:1;cursor:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.l2d-panel-btn{flex:none;width:26px;height:26px;display:grid;place-items:center;',
    'border:none;border-radius:var(--dsh-radius-md);background:transparent;',
    'color:var(--dsh-ink-muted);font:var(--dsh-text-sm);line-height:1;cursor:pointer;',
    'transition:background var(--dsh-dur-fast) var(--dsh-ease),color var(--dsh-dur-fast) var(--dsh-ease);}',
    '.l2d-panel-btn:hover{background:var(--dsh-hover);color:var(--dsh-ink);}',
    '.l2d-panel-body{overflow:auto;min-height:0;',
    'padding:var(--dsh-space-4);display:flex;flex-direction:column;gap:var(--dsh-space-3);}',
    '.l2d-panel.collapsed .l2d-panel-body,.l2d-panel.collapsed .l2d-ph{display:none;}',
    // 八向缩放手柄：四边条 + 四角块（角为触屏大热区），最大化/全屏态隐藏
    '.l2d-ph{position:absolute;z-index:2;touch-action:none;}',
    '.l2d-ph[data-dir="n"]{top:-4px;left:12px;right:12px;height:9px;cursor:ns-resize;}',
    '.l2d-ph[data-dir="s"]{bottom:-4px;left:12px;right:12px;height:9px;cursor:ns-resize;}',
    '.l2d-ph[data-dir="e"]{right:-4px;top:12px;bottom:12px;width:9px;cursor:ew-resize;}',
    '.l2d-ph[data-dir="w"]{left:-4px;top:12px;bottom:12px;width:9px;cursor:ew-resize;}',
    '.l2d-ph[data-dir="ne"]{top:-5px;right:-5px;width:20px;height:20px;cursor:nesw-resize;}',
    '.l2d-ph[data-dir="nw"]{top:-5px;left:-5px;width:20px;height:20px;cursor:nwse-resize;}',
    '.l2d-ph[data-dir="se"]{bottom:-5px;right:-5px;width:20px;height:20px;cursor:nwse-resize;}',
    '.l2d-ph[data-dir="sw"]{bottom:-5px;left:-5px;width:20px;height:20px;cursor:nesw-resize;}',
    '.l2d-ph[data-dir="se"]::after{content:\'\';position:absolute;right:6px;bottom:6px;width:7px;height:7px;',
    'border-right:2px solid var(--dsh-line-strong);border-bottom:2px solid var(--dsh-line-strong);}',
    '.l2d-panel.maximized .l2d-ph,.l2d-panel.fullscreen .l2d-ph{display:none;}',
    // 边缘吸附预览
    '.l2d-snap-ghost{position:fixed;left:0;top:0;z-index:2147483190;',
    'background:var(--dsh-accent-soft);border:1px solid var(--dsh-accent);',
    'border-radius:var(--dsh-radius-lg);opacity:0;pointer-events:none;',
    'transition:opacity var(--dsh-dur-fast) var(--dsh-ease);}',
    '.l2d-snap-ghost.on{opacity:0.55;}',
    // 容器查询：>600px 双列表单，≤600px 单列紧凑（折叠侧栏语义：窄容器只留主列）
    '@container (min-width:601px){',
    '.l2d-panel-body{display:grid;grid-template-columns:1fr 1fr;align-items:start;}',
    '.l2d-panel .l2d-hint,.l2d-panel .l2d-actions{grid-column:1/-1;}}',
    '@container (max-width:600px){',
    '.l2d-panel-body{padding:var(--dsh-space-3);gap:var(--dsh-space-2);}}',
    'body.l2d-panel-interacting,body.l2d-panel-interacting *{user-select:none !important;-webkit-user-select:none !important;cursor:default;}',
    '.l2d-panel .l2d-row{display:flex;flex-direction:column;gap:var(--dsh-space-2);}',
    '.l2d-panel .l2d-row label{font:var(--dsh-text-xs);color:var(--dsh-ink-muted);}',
    '.l2d-panel .l2d-row input[type=password],.l2d-panel .l2d-row input[type=number],.l2d-panel .l2d-row select',
    '{width:100%;box-sizing:border-box;padding:var(--dsh-space-2) var(--dsh-space-3);border-radius:var(--dsh-radius-md);',
    'border:1px solid var(--dsh-line);background:var(--dsh-surface-sunken);color:var(--dsh-ink);',
    'font:var(--dsh-text-sm);outline:none;}',
    '.l2d-panel .l2d-row input:focus,.l2d-panel .l2d-row select:focus{border-color:var(--dsh-accent);}',
    '.l2d-panel input[type=checkbox],.l2d-panel input[type=range]{accent-color:var(--dsh-accent);}',
    '.l2d-panel .l2d-inline{display:flex;align-items:center;gap:var(--dsh-space-3);}',
    '.l2d-panel .l2d-inline input[type=range]{flex:1;}',
    '.l2d-panel .l2d-actions{display:flex;gap:var(--dsh-space-2);justify-content:flex-end;}',
    '.l2d-panel .l2d-actions button{border:1px solid var(--dsh-line);border-radius:var(--dsh-radius-md);',
    'padding:var(--dsh-space-2) var(--dsh-space-4);font:var(--dsh-text-sm);',
    'cursor:pointer;background:transparent;color:var(--dsh-ink);}',
    '.l2d-panel .l2d-actions button.primary{background:var(--dsh-accent);color:var(--dsh-on-accent);border-color:transparent;}',
    '.l2d-panel .l2d-hint{font:var(--dsh-text-xs);color:var(--dsh-ink-muted);}',
    '.l2d-row label{transition:color var(--dsh-dur-fast) var(--dsh-ease);}',
    '.l2d-row.l2d-group-flash label{color:var(--dsh-accent);}',
    '#dsh-l2d-root :focus-visible,.l2d-menu :focus-visible,.l2d-panel :focus-visible{outline:2px solid var(--dsh-accent);outline-offset:2px;}',
    '/* Editor-style overlay: align injected floats with studio tokens. */',
    '#dsh-l2d-root,.l2d-menu,.l2d-panel,.l2d-logpanel,#dsh-l2d-error-dialog{font-family:var(--studio-font-ui,system-ui);color:var(--studio-ink,#e9ecf3);}',
    '.l2d-menu,.l2d-panel,.l2d-logpanel{background:var(--studio-surface,#141821);border:1px solid var(--studio-line-strong,rgba(232,236,245,.22));border-radius:var(--studio-radius-md,10px);box-shadow:var(--studio-shadow-2,0 8px 24px rgba(0,0,0,.45));}',
    '.l2d-menu{padding:6px;min-width:200px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;min-height:0;scrollbar-width:thin;scrollbar-color:var(--studio-line-strong,rgba(232,236,245,.22)) transparent;}',
    '.l2d-menu button{min-height:var(--studio-row-h,36px);padding:0 10px;border:1px solid transparent;border-radius:var(--studio-radius-sm,6px);font:var(--studio-text-sm,400 13px/1.5 system-ui);color:var(--studio-ink-2,#aeb7c7);background:transparent;transition:background var(--studio-transition-fast,100ms),color var(--studio-transition-fast,100ms),border-color var(--studio-transition-fast,100ms),box-shadow var(--studio-transition-fast,100ms),transform var(--studio-transition-fast,100ms);}',
    '.l2d-menu button:hover{background:var(--studio-hover,rgba(232,236,245,.06));color:var(--studio-ink,#e9ecf3);}',
    '.l2d-menu button:active{background:var(--studio-active,rgba(232,236,245,.11));transform:translateY(1px);}',
    '.l2d-menu button[data-state~="selected"]{background:var(--studio-selected,rgba(157,193,255,.16));color:var(--studio-accent-soft-ink,#d6e6ff);box-shadow:inset 2px 0 0 var(--studio-accent,#9dc1ff);}',
    '.l2d-menu button:disabled,.l2d-menu button[data-state~="disabled"],.l2d-panel .l2d-actions button:disabled,.l2d-panel .l2d-actions button[data-state~="disabled"],.l2d-panel-btn:disabled,.l2d-qc-send:disabled,.l2d-logpanel-head button:disabled{opacity:var(--studio-state-disabled-opacity,.42);cursor:not-allowed;}',
    '.l2d-menu button[data-state~="loading"],.l2d-panel .l2d-actions button[data-state~="loading"],.l2d-qc-send[data-state~="loading"]{cursor:progress;color:var(--studio-ink-2,#aeb7c7);}',
    '.l2d-menu button[data-state~="error"],.l2d-qc-input[data-state~="error"],.l2d-panel .l2d-row input[data-state~="error"]{border-color:var(--studio-danger,#ffb4ab);color:var(--studio-danger,#ffb4ab);}',
    '.l2d-menu button[data-state~="success"],.l2d-qc-input[data-state~="success"],.l2d-panel .l2d-row input[data-state~="success"]{border-color:var(--studio-ok,#8fd0a8);}',
    '.l2d-menu .l2d-menu-title{padding:6px 10px 8px;font:var(--studio-text-micro,500 10px/1.3 monospace);letter-spacing:1px;text-transform:uppercase;color:var(--studio-ink-3,#737f92);}',
    '#dsh-l2d-root :focus-visible,.l2d-menu :focus-visible,.l2d-panel :focus-visible,.l2d-logpanel :focus-visible{outline:none;box-shadow:var(--studio-focus-ring,0 0 0 2px #141821,0 0 0 4px #9dc1ff);}',
    '.l2d-qc{gap:var(--studio-gutter-sm,12px);padding:6px 10px 10px;}',
    '.l2d-qc-input{box-sizing:border-box;width:100%;min-height:var(--studio-control-h,36px);max-height:120px;padding:7px 10px;border:1px solid var(--studio-line-strong,rgba(232,236,245,.22));border-radius:var(--studio-radius-sm,6px);background:var(--studio-surface-sunken,#090b10);color:var(--studio-ink,#e9ecf3);font:var(--studio-text-sm,400 13px/1.5 system-ui);font-family:var(--studio-font-mono,ui-monospace,Consolas,monospace);transition:border-color var(--studio-transition-fast,100ms),box-shadow var(--studio-transition-fast,100ms),background var(--studio-transition-fast,100ms);}',
    '.l2d-qc-input::placeholder{color:var(--studio-ink-3,#737f92);}',
    '.l2d-qc-input:hover:not(:disabled){border-color:var(--studio-ink-3,#737f92);}',
    '.l2d-qc-input:focus-visible{outline:none;border-color:var(--studio-accent,#9dc1ff);box-shadow:var(--studio-focus-ring,0 0 0 2px #141821,0 0 0 4px #9dc1ff);}',
    '.l2d-qc-input:disabled{opacity:var(--studio-state-disabled-opacity,.42);cursor:not-allowed;}',
    '.l2d-qc-hint{font:var(--studio-text-xs,400 11px/1.45 system-ui);color:var(--studio-ink-3,#737f92);padding:0 10px;}',
    '.l2d-qc-send{min-height:var(--studio-control-h-sm,32px);padding:0 12px;border:1px solid var(--studio-line-strong,rgba(232,236,245,.22));border-radius:var(--studio-radius-sm,6px);background:var(--studio-surface-2,#1c2230);color:var(--studio-ink,#e9ecf3);font:var(--studio-text-label,500 12px/1.4 system-ui);cursor:pointer;transition:background var(--studio-transition-fast,100ms),border-color var(--studio-transition-fast,100ms),transform var(--studio-transition-fast,100ms);}',
    '.l2d-qc-send:hover{background:var(--studio-hover,rgba(232,236,245,.06));border-color:var(--studio-accent,#9dc1ff);}',
    '.l2d-qc-send:active{background:var(--studio-active,rgba(232,236,245,.11));transform:translateY(1px);}',
    '.l2d-logpanel{width:min(360px,calc(100vw - 24px));height:min(360px,calc(100vh - 24px));max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);}',
    '.l2d-logpanel-head{min-height:40px;padding:0 var(--studio-gutter,16px);border-bottom:1px solid var(--studio-line,rgba(232,236,245,.10));font:var(--studio-text-label,500 12px/1.4 system-ui);color:var(--studio-ink-2,#aeb7c7);}',
    '.l2d-logpanel-head button{min-height:var(--studio-control-h-sm,32px);padding:0 10px;border:1px solid var(--studio-line-strong,rgba(232,236,245,.22));border-radius:var(--studio-radius-sm,6px);background:var(--studio-surface-2,#1c2230);color:var(--studio-ink,#e9ecf3);font:var(--studio-text-label,500 12px/1.4 system-ui);cursor:pointer;transition:background var(--studio-transition-fast,100ms),border-color var(--studio-transition-fast,100ms);}',
    '.l2d-logpanel-head button:hover{background:var(--studio-hover,rgba(232,236,245,.06));border-color:var(--studio-accent,#9dc1ff);}',
    '.l2d-logpanel-body{padding:var(--studio-gutter-sm,12px);font:var(--studio-text-xs,400 11px/1.45 system-ui);font-family:var(--studio-font-mono,ui-monospace,Consolas,monospace);color:var(--studio-ink-2,#aeb7c7);}',
    '.l2d-logline[data-state~="ok"]{color:var(--studio-ok,#8fd0a8);}',
    '.l2d-logline[data-state~="warn"]{color:var(--studio-warn,#f2cc60);}',
    '.l2d-logline[data-state~="error"]{color:var(--studio-danger,#ffb4ab);}',
    '.l2d-logline[data-state~="info"]{color:var(--studio-info,#9dc1ff);}',
    '.l2d-panel-head{min-height:40px;padding:0 var(--studio-gutter,16px);border-bottom:1px solid var(--studio-line,rgba(232,236,245,.10));}',
    '.l2d-panel-head h4{font:var(--studio-text-lg,500 16px/1.4 system-ui);color:var(--studio-ink,#e9ecf3);}',
    '.l2d-panel-btn{width:var(--studio-control-h-sm,32px);height:var(--studio-control-h-sm,32px);border-radius:var(--studio-radius-sm,6px);color:var(--studio-ink-2,#aeb7c7);transition:background var(--studio-transition-fast,100ms),color var(--studio-transition-fast,100ms);}',
    '.l2d-panel-btn:hover{background:var(--studio-hover,rgba(232,236,245,.06));color:var(--studio-ink,#e9ecf3);}',
    '.l2d-panel-body{padding:var(--studio-gutter,16px);gap:var(--studio-gutter-sm,12px);}',
    '.l2d-panel .l2d-row{gap:6px;}',
    '.l2d-panel .l2d-row label{font:var(--studio-text-label,500 12px/1.4 system-ui);color:var(--studio-ink-2,#aeb7c7);}',
    '.l2d-panel .l2d-row input[type=password],.l2d-panel .l2d-row input[type=number],.l2d-panel .l2d-row select{padding:7px 10px;border:1px solid var(--studio-line-strong,rgba(232,236,245,.22));border-radius:var(--studio-radius-sm,6px);background:var(--studio-surface-sunken,#090b10);color:var(--studio-ink,#e9ecf3);font:var(--studio-text-sm,400 13px/1.5 system-ui);transition:border-color var(--studio-transition-fast,100ms),box-shadow var(--studio-transition-fast,100ms);}',
    '.l2d-panel .l2d-row input:hover:not(:disabled),.l2d-panel .l2d-row select:hover:not(:disabled){border-color:var(--studio-ink-3,#737f92);}',
    '.l2d-panel .l2d-row input:focus-visible,.l2d-panel .l2d-row select:focus-visible{outline:none;border-color:var(--studio-accent,#9dc1ff);box-shadow:var(--studio-focus-ring,0 0 0 2px #141821,0 0 0 4px #9dc1ff);}',
    '.l2d-panel input[type=checkbox],.l2d-panel input[type=range]{accent-color:var(--studio-accent,#9dc1ff);}',
    '.l2d-panel .l2d-actions button{min-height:var(--studio-control-h-sm,32px);padding:0 12px;border:1px solid var(--studio-line-strong,rgba(232,236,245,.22));border-radius:var(--studio-radius-sm,6px);background:var(--studio-surface-2,#1c2230);color:var(--studio-ink,#e9ecf3);font:var(--studio-text-label,500 12px/1.4 system-ui);cursor:pointer;transition:background var(--studio-transition-fast,100ms),border-color var(--studio-transition-fast,100ms),transform var(--studio-transition-fast,100ms);}',
    '.l2d-panel .l2d-actions button:hover{background:var(--studio-hover,rgba(232,236,245,.06));border-color:var(--studio-accent,#9dc1ff);}',
    '.l2d-panel .l2d-actions button:active{background:var(--studio-active,rgba(232,236,245,.11));transform:translateY(1px);}',
    '.l2d-panel .l2d-actions button.primary{background:var(--studio-accent,#9dc1ff);color:var(--studio-on-accent,#0b1b33);border-color:var(--studio-accent,#9dc1ff);}',
    '.l2d-panel .l2d-hint{font:var(--studio-text-xs,400 11px/1.45 system-ui);color:var(--studio-ink-3,#737f92);}',
    '#dsh-l2d-root .l2d-bubble{max-width:min(200px,calc(100vw - 24px));padding:var(--studio-gutter-sm,12px) var(--studio-gutter,16px);border-radius:var(--studio-radius-md,10px);font:var(--studio-text-sm,400 13px/1.5 system-ui);box-shadow:var(--studio-shadow-2,0 8px 24px rgba(0,0,0,.45));background:var(--dsh-bubble-bg);color:var(--dsh-bubble-ink);}',
    '#dsh-l2d-root .l2d-chip{min-height:22px;padding:0 var(--studio-gutter-sm,12px);border-radius:var(--studio-radius-full,999px);font:var(--studio-text-micro,500 10px/1.3 monospace);background:var(--studio-surface,#141821);color:var(--studio-ink-2,#aeb7c7);border:1px solid var(--studio-line,rgba(232,236,245,.10));box-shadow:var(--studio-shadow-1,0 1px 2px rgba(0,0,0,.40));}',
    '#dsh-l2d-root .l2d-chip:hover{background:var(--studio-hover,rgba(232,236,245,.06));color:var(--studio-ink,#e9ecf3);}',
    '#dsh-l2d-root .l2d-price{max-width:min(360px,calc(100vw - 24px));padding:var(--studio-gutter-sm,12px) var(--studio-gutter,16px);border-radius:var(--studio-radius-md,10px);font:var(--studio-text-xs,400 11px/1.45 system-ui);background:var(--studio-surface,#141821);color:var(--studio-ink,#e9ecf3);border:1px solid var(--studio-line,rgba(232,236,245,.10));box-shadow:var(--studio-shadow-2,0 8px 24px rgba(0,0,0,.45));}',
    '#dsh-l2d-root .l2d-gear{border-radius:var(--studio-radius-full,999px);background:var(--studio-surface,#141821);color:var(--studio-ink,#e9ecf3);border:1px solid var(--studio-line,rgba(232,236,245,.10));box-shadow:var(--studio-shadow-1,0 1px 2px rgba(0,0,0,.40));}',
    '#dsh-l2d-root .l2d-gear:hover{background:var(--studio-hover,rgba(232,236,245,.06));}',
    '.l2d-snap-ghost{background:var(--studio-accent-soft,#24334a);border:1px solid var(--studio-accent,#9dc1ff);border-radius:var(--studio-radius-md,10px);}',
    '@media (max-width:1023px){.l2d-logpanel{width:min(320px,calc(100vw - 24px));}.l2d-menu{max-width:calc(100vw - 16px);}}',
    '@media (max-width:719px){.l2d-logpanel{width:calc(100vw - 24px);height:min(320px,50vh);right:12px;top:12px;}.l2d-panel-body{padding:var(--studio-gutter-sm,12px);}.l2d-qc-input{max-height:96px;}}',
    '@media (prefers-reduced-motion: reduce){#dsh-l2d-root .l2d-body,#dsh-l2d-root .l2d-bubble,#dsh-l2d-root .l2d-chip,#dsh-l2d-root .l2d-gear,#dsh-l2d-root .l2d-price,.l2d-menu button,.l2d-panel-btn,.l2d-panel .l2d-actions button,.l2d-qc-input,.l2d-qc-send,.l2d-logpanel-head button,.l2d-row label,.l2d-snap-ghost,.l2d-yandere-fx{transition:none !important;}}'
  ].join('');

  // ---- P0-PiP：错误处理对话框样式（自包含常量）----
  // 页内降级卡片与画中画窗口共用同一份 CSS。刻意不依赖 --dsh-* 变量：
  // Document PiP 是独立 document，主文档的 token 样式表不会生效。
  // 页内形态：右下角小卡片（不再全屏遮罩糊脸，页面照常可操作）。
  var ERROR_DIALOG_CSS = [
    '#dsh-l2d-error-dialog{position:fixed;right:16px;bottom:16px;z-index:2147483647;',
    'pointer-events:auto;font-family:var(--studio-font-ui,system-ui,-apple-system,"Segoe UI",sans-serif);}',
    '#dsh-l2d-error-dialog .l2d-error-card{width:min(360px,calc(100vw - 32px));',
    'max-height:min(480px,80vh);overflow:auto;padding:0;box-sizing:border-box;',
    'border:1px solid #333b4a;border-radius:10px;background:#141821;color:#e9ecf3;',
    'box-shadow:0 20px 48px rgba(0,0,0,.55);}',
    '#dsh-l2d-error-dialog .l2d-error-title{font-size:15px;font-weight:600;margin:0;',
    'padding:16px 16px 12px;border-bottom:1px solid #333b4a;color:#e9ecf3;}',
    '#dsh-l2d-error-dialog .l2d-error-message{font-size:12px;line-height:1.6;color:#aeb7c7;',
    'word-break:break-all;margin:0;padding:16px;}',
    '#dsh-l2d-error-dialog button{display:block;width:calc(100% - 32px);margin:0 16px 8px;padding:10px;',
    'border:1px solid #333b4a;border-radius:6px;background:#1c2230;color:#e9ecf3;cursor:pointer;',
    'font-size:13px;text-align:left;transition:background 100ms,border-color 100ms;}',
    '#dsh-l2d-error-dialog button:last-child{margin-bottom:16px;}',
    '#dsh-l2d-error-dialog button:hover{background:#242c3a;border-color:#9dc1ff;}',
    '#dsh-l2d-error-dialog button:active{transform:translateY(1px);}',
    '#dsh-l2d-error-dialog button:focus-visible{outline:none;box-shadow:0 0 0 2px #141821,0 0 0 4px #9dc1ff;}',
    '#dsh-l2d-error-dialog button[data-state~="disabled"],#dsh-l2d-error-dialog button:disabled{opacity:.42;cursor:not-allowed;}',
    '#dsh-l2d-error-dialog button[data-state~="loading"]{cursor:progress;color:#aeb7c7;}',
    '#dsh-l2d-error-dialog button[data-state~="error"]{border-color:#ffb4ab;color:#ffb4ab;}',
    '#dsh-l2d-error-dialog button[data-state~="success"]{border-color:#8fd0a8;color:#8fd0a8;}',
    '#dsh-l2d-error-dialog button[data-action="retry"]{border-color:#9dc1ff;background:#24334a;color:#d6e6ff;}',
    '@media (max-width:719px){#dsh-l2d-error-dialog{right:12px;bottom:12px;}',
    '#dsh-l2d-error-dialog .l2d-error-card{width:calc(100vw - 24px);max-height:70vh;}}',
    '@media (prefers-reduced-motion: reduce){#dsh-l2d-error-dialog button{transition:none !important;}}'
  ].join('');

  var root = null;
  var imgEl = null;
  var bubbleEl = null;
  var chipEl = null;
  var bodyEl = null;
  var priceEl = null;
  var menuEl = null;

  // 同步读令牌表，避免第一帧没有颜色。地址跟着 overlay.js 自己的 src 走，
  // 这样插件（/dsh-l2d/）和调试服都对得上。读失败时组件仍能挂上，只是退回浏览器默认色。
  function readTokenCss() {
    var href = '/dsh-l2d/ui-tokens.css';
    var nodes = document.getElementsByTagName('script');
    for (var i = nodes.length - 1; i >= 0; i--) {
      var src = nodes[i].getAttribute('src') || '';
      var at = src.indexOf('overlay.js');
      if (at >= 0) {
        href = src.slice(0, at) + 'ui-tokens.css';
        break;
      }
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', href, false);
      xhr.send();
      if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) return xhr.responseText;
    } catch (e) { /* 令牌路由没挂上 */ }
    return '';
  }

  function ensureMounted() {
    if (document.getElementById(ROOT_ID)) return;
    if (!document.body) return;

    var style = document.createElement('style');
    style.setAttribute('data-dsh-l2d', 'style');
    style.textContent = readTokenCss() + STYLE_TEXT + ERROR_DIALOG_CSS;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = ROOT_ID;
    // P0 修复：初始故障状态写进 dataset，失败态 CSS（300×300 收缩）从第一帧就生效
    try { root.dataset.l2dState = L2D_RECOVERY.state || 'initializing'; } catch (err) { /* ignore */ }

    bubbleEl = document.createElement('div');
    bubbleEl.className = 'l2d-bubble';

    bodyEl = document.createElement('div');
    bodyEl.className = 'l2d-body';

    // 主渲染：Canvas + Cubism（真实 Live2D）；图片仅作为渲染失败时的兜底
    canvasEl = document.createElement('canvas');
    canvasEl.className = 'l2d-canvas';
    bodyEl.appendChild(canvasEl);

    imgEl = document.createElement('img');
    imgEl.alt = 'DSH-L2D';
    imgEl.draggable = false;
    imgEl.style.display = 'none';
    imgEl.addEventListener('error', usePlaceholder);
    imgEl.addEventListener('load', function () {
      if (imgEl.naturalWidth <= 1 || imgEl.naturalHeight <= 1) usePlaceholder();
    });
    bodyEl.appendChild(imgEl);

    chipEl = document.createElement('div');
    chipEl.className = 'l2d-chip';
    chipEl.title = '实时性能 · 点击切换情境 · 拖动角色可移动';

    var gear = document.createElement('button');
    gear.className = 'l2d-gear';
    gear.type = 'button';
    gear.title = '设置';
    gear.textContent = '\u2699';
    gear.addEventListener('click', function (e) {
      e.stopPropagation();
      openSettingsDrawer();
    });

    // P0-PiP：failed 态唯一页内元素（48×48 徽标）。点击 = user gesture，
    // 保证 Document PiP requestWindow 的 transient activation 成立。
    var miniBadge = document.createElement('button');
    miniBadge.className = 'l2d-mini-badge';
    miniBadge.type = 'button';
    miniBadge.title = 'Live2D 加载失败 · 点击打开恢复窗口';
    miniBadge.textContent = '\u26a0';
    miniBadge.addEventListener('click', function (e) {
      e.stopPropagation();
      openL2DErrorUi(L2D_RECOVERY.lastError);
    });

    panelEl = document.createElement('div');
    panelEl.className = 'l2d-panel';

    priceEl = document.createElement('div');
    priceEl.className = 'l2d-price';

    menuEl = document.createElement('div');
    menuEl.className = 'l2d-menu';
    menuEl.setAttribute('aria-hidden', 'true');

    root.appendChild(bubbleEl);
    root.appendChild(bodyEl);
    root.appendChild(chipEl);
    root.appendChild(gear);
    root.appendChild(priceEl);
    root.appendChild(miniBadge);
    document.body.appendChild(root);
    document.body.appendChild(menuEl);
    document.body.appendChild(panelEl);
    menuEl.addEventListener('wheel', function (e) {
      e.stopPropagation();
    }, { passive: true });
    window.addEventListener('wheel', function (e) {
      if (menuEl && menuEl.classList.contains('open') && menuEl.contains(e.target)) {
        e.stopPropagation();
      }
    }, { capture: true, passive: true });

    loadSettings();
    initRenderer();

    applyPrefs();
    bindDrag();
    bindClick();
    startAnim();
    observeRemoval();
    // 先绑鼠标/注视：启动链里任何一步抛错都不能连累眼追（历史事故见文件头注释）
    initEmotionSensors();
    initEnvironmentSensors();
    startSettingsWatch();
    startAiPoll();
    startAgentPoll();
    startPerfChip(); // UI4：chip 常驻 FPS/分辨率实时读数
  }

  function usePlaceholder() {
    if (!bodyEl || bodyEl.querySelector('.l2d-placeholder')) return;
    var ph = document.createElement('div');
    ph.className = 'l2d-placeholder';
    // 用户反馈：渲染失败时右下角的占位色块被当成「调试窗口」。这里明示用途，
    // 悬停有 tooltip，出现时气泡说明一次（say 内部有节流，不刷屏）。
    ph.title = '立绘渲染占位：模型/静态图未加载成功时显示（重启宿主可重试）';
    ph.setAttribute('aria-hidden', 'true');
    if (imgEl) imgEl.style.display = 'none';
    bodyEl.appendChild(ph);
    say('立绘没加载出来，先用占位图形顶着（重启宿主可重试）', 4200);
  }

  // 角色左上角：pos 是逻辑目标（拖拽/持久化），spring 是渲染位置。
  // 恢复惯性但不用“甩出初速度”：临界阻尼弹簧只收敛到松手点，不会飞出屏幕。
  var pos = { x: null, y: null };
  var spring = { x: null, y: null, vx: 0, vy: 0, active: false, raf: 0, lastAt: 0 };

  function renderSpring() {
    if (!root || spring.x === null || spring.y === null) return;
    root.style.transform = 'translate3d(' + spring.x + 'px,' + spring.y + 'px,0)';
  }

  function snapSpringToTarget() {
    if (pos.x === null || pos.y === null) return;
    spring.x = pos.x;
    spring.y = pos.y;
    spring.vx = 0;
    spring.vy = 0;
    spring.active = false;
    renderSpring();
  }

  function applyPos() {
    if (!root) return;
    if (pos.x === null || pos.y === null) {
      var w = root.offsetWidth || 320;
      var h = root.offsetHeight || 400;
      pos.x = Math.max(0, window.innerWidth - w - 24);
      pos.y = Math.max(0, window.innerHeight - h - 24);
    }
    snapSpringToTarget();
  }

  function clampPos(x, y) {
    var w = root ? root.offsetWidth || 320 : 320;
    var h = root ? root.offsetHeight || 400 : 400;
    return {
      x: Math.max(-w * 0.35, Math.min(window.innerWidth - w * 0.65, x)),
      y: Math.max(0, Math.min(window.innerHeight - h * 0.25, y)),
    };
  }

  // 临界阻尼解析解：任意帧率稳定，收敛不超调。松手后没有额外初速度。
  function stepSpring(now) {
    if (pos.x === null || pos.y === null) return false;
    if (spring.x === null || spring.y === null) snapSpringToTarget();

    var dt = spring.lastAt ? Math.max(0, (now - spring.lastAt) / 1000) : 0.016;
    spring.lastAt = now;
    if (dt > 0.05) dt = 0.05;

    var omega = 24;
    var dx = spring.x - pos.x;
    var dy = spring.y - pos.y;

    function axis(x, v, d) {
      var b = v + omega * d;
      var e = Math.exp(-omega * dt);
      // 闭式解：x_new = target + (d + b*dt)*e，target = x - d。
      // 上一版漏了「- d」，误差每帧被放大（60fps 下 ×1.6），就是“飞走”的根因。
      return { x: x - d + (d + b * dt) * e, v: (v - omega * b * dt) * e };
    }

    var rx = axis(spring.x, spring.vx, dx);
    var ry = axis(spring.y, spring.vy, dy);
    spring.x = rx.x;
    spring.vx = rx.v;
    spring.y = ry.x;
    spring.vy = ry.v;

    var settled =
      !physics.dragging &&
      Math.abs(spring.x - pos.x) < 0.08 &&
      Math.abs(spring.y - pos.y) < 0.08 &&
      Math.abs(spring.vx) < 2 &&
      Math.abs(spring.vy) < 2;
    if (settled) {
      snapSpringToTarget();
      // 弹簧收敛后位置才真正定下来：此时再重锚一次注视（拖拽中途不跟，避免抢镜）
      reanchorGaze();
      return false;
    }
    spring.active = true;
    renderSpring();
    return true;
  }

  function ensureSpringLoop() {
    if (spring.raf || pos.x === null) return;
    spring.lastAt = performance.now();
    var loop = function () {
      spring.raf = 0;
      if (!stepSpring(performance.now())) return;
      spring.raf = requestAnimationFrame(loop);
    };
    spring.raf = requestAnimationFrame(loop);
  }

  // ---- 性能上屏 chip：常驻显示渲染 FPS + 画布分辨率（替换原「待机」状态文字常驻）----
  // FPS 数据源 = 渲染包 window.DSH_L2D.getInfo().frames 差分（真实渲染帧率，走渲染帧循环计数，
  // 不是 vsync 计数）；模型未就绪 getInfo 返回 null 时显示「— fps」。每秒刷新一次。
  // 情境切换（手动/环境层）时闪现情境名 2 秒保留反馈，之后回到性能读数。
  var perfChip = { timer: 0, lastFrames: -1, flashUntil: 0, flashText: '' };

  function paintPerfChip() {
    if (!chipEl) return;
    if (Date.now() < perfChip.flashUntil) {
      chipEl.textContent = perfChip.flashText;
      return;
    }
    var info = null;
    try {
      var L = window.DSH_L2D;
      info = L && typeof L.getInfo === 'function' ? L.getInfo() : null;
    } catch (e) { info = null; }
    var fpsText = '—';
    if (info && typeof info.frames === 'number') {
      if (perfChip.lastFrames >= 0) {
        var df = info.frames - perfChip.lastFrames;
        if (df >= 0 && df <= 999) fpsText = String(df);
      }
      perfChip.lastFrames = info.frames;
    }
    var w = canvasEl ? canvasEl.width : 0;
    var h = canvasEl ? canvasEl.height : 0;
    chipEl.textContent = fpsText + ' fps · ' + w + '×' + h;
  }

  function flashChipState(state) {
    perfChip.flashText = LABEL[state] || String(state || '');
    perfChip.flashUntil = Date.now() + 2000;
    paintPerfChip();
  }

  function startPerfChip() {
    if (perfChip.timer) return;
    paintPerfChip();
    perfChip.timer = setInterval(paintPerfChip, 1000);
  }

  function applyPrefs() {
    if (!root) return;
    root.className = prefs.state;
    // 兼容旧版存下的 left/top（有数值就用，否则走右下角默认位）
    pos.x = typeof prefs.left === 'number' ? prefs.left : null;
    pos.y = typeof prefs.top === 'number' ? prefs.top : null;
    applyPos();
    // chip 常驻改为性能读数；情境名只闪现 2 秒（UI4：性能监控上屏替换待机文字）
    flashChipState(prefs.state);
  }

  function setState(next) {
    // 手动切换优先：60s 内环境层不自动改状态，避免刚点完就被覆盖
    env.manualUntil = Date.now() + 60000;
    prefs.state = next;
    pushL2dLog({ comp: 'stage', state: next });
    persist();
    if (root) root.className = next;
    flashChipState(next); // chip 常驻为性能读数，情境名闪现 2 秒（UI4）
    say(BUBBLE[next] && BUBBLE[next][Math.floor(Math.random() * BUBBLE[next].length)]);
  }

  var bubbleTimer = null;

  // ---- 调试日志：环形缓冲纯函数块（自包含，单测 debug-log.test.mjs 用 vm 抽取本段真实验证） ----
  var L2D_LOG_MAX_CHARS = 8192;
  var L2D_LOG_MAX_AGE_MS = 30 * 60 * 1000;
  var l2dLogEntries = [];
  var l2dLogSeq = 0;

  /** 删除 now - t > 30min 的过期条目；push 时顺带调用 */
  function pruneL2dLog(now) {
    var nowMs = typeof now === 'number' ? now : Date.now();
    var keep = [];
    for (var i = 0; i < l2dLogEntries.length; i++) {
      var e = l2dLogEntries[i];
      if (e && typeof e.t === 'number' && nowMs - e.t <= L2D_LOG_MAX_AGE_MS) keep.push(e);
    }
    l2dLogEntries = keep;
  }

  /**
   * 追加一条日志（字段缺省补默认值），随后 prune 过期；若 JSON 总字符超
   * L2D_LOG_MAX_CHARS 则从最旧开始丢弃（滚动覆盖）。畸形入参一律不抛——
   * 日志是观测面，绝不能连累主流程。
   */
  function pushL2dLog(entry) {
    try {
      l2dLogSeq += 1;
      var src = entry && typeof entry === 'object' ? entry : {};
      var model = '—';
      try {
        var L = typeof window !== 'undefined' ? window.DSH_L2D : null;
        var modelName = L && (L.modelName || L.model);
        if (modelName) model = String(modelName);
      } catch (err) { /* 拿不到就用 '—' */ }
      l2dLogEntries.push({
        t: typeof src.t === 'number' ? src.t : Date.now(),
        comp: String(src.comp || 'overlay'),
        state: String(src.state == null ? '' : src.state),
        model: model,
        action: String(src.action == null ? '' : src.action),
        seq: l2dLogSeq,
        skill: String(src.skill || '—'),
      });
      pruneL2dLog(Date.now());
      var total = 0;
      var i;
      for (i = 0; i < l2dLogEntries.length; i++) {
        try { total += JSON.stringify(l2dLogEntries[i]).length; }
        catch (err) { total += 64; }
      }
      while (total > L2D_LOG_MAX_CHARS && l2dLogEntries.length > 1) {
        var oldest = l2dLogEntries.shift();
        try { total -= JSON.stringify(oldest).length; }
        catch (err) { total -= 64; }
      }
      return l2dLogEntries.length;
    } catch (e) {
      return -1;
    }
  }

  /** 纯渲染：返回行文本数组（HH:MM:SS comp state action #seq，最新在底）；面板 DOM 更新另做 */
  function renderL2dLog() {
    var lines = [];
    var p = function (num) { return num < 10 ? '0' + num : String(num); };
    for (var i = 0; i < l2dLogEntries.length; i++) {
      var e = l2dLogEntries[i];
      var d = new Date(typeof e.t === 'number' ? e.t : 0);
      lines.push(
        p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
        + ' ' + e.comp + ' ' + e.state + ' ' + e.action + ' #' + e.seq
      );
    }
    return lines;
  }

  if (typeof window !== 'undefined') {
    window.DSH_L2D_LOG__ = {
      push: pushL2dLog,
      entries: function () { return l2dLogEntries.slice(); },
      prune: pruneL2dLog,
      MAX_CHARS: L2D_LOG_MAX_CHARS,
    };
  }

  // ---- 字幕准入：参数 / 模板 / JSON / 标签片段在渲染出口前一律剔除，只放行自然语言 ----
  // 以下三个标识符自包含（不引用本模块其它变量），单测用 vm 抽取本段真实实现直接验证。
  var CAPTION_PARAM_RE = new RegExp([
    /[A-Za-z_][A-Za-z0-9_.]*\s*(?:==|=|:)\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/,
    /\b(?:Param[A-Za-z0-9_]*|Clothes\d+|Hair\d+|LEar\d+|REar\d+|BodyAngle[XYZ]|Angle[XYZ]|AngryMove)\b/,
    /\{\s*"[^"]+"\s*:[^}]*\}/,
    /"(?:paramId|value|values|param|track|key|weight|durationMs|schemaVersion|chain_id|args)"\s*:/,
    /\$\{[^}]*\}|\{\{[^}]*\}\}|<\/?[A-Za-z_][^>]*>|%[sdif]/,
    /\b(?:setParameters?|readParameters?|applyAppearance|setSwitch|setBodyType)\s*\([^)]*\)/,
  ].map(function (r) { return r.source; }).join('|'), 'g');

  // 准入字符白名单：不含 = { } $ | ` < > 等参数语法特征；英文冒号保留，避免误伤普通字幕。
  var CAPTION_ALLOW_RE = /[\u3400-\u9fff\u3040-\u30ffA-Za-z0-9\s\u3000-\u303f\uff01-\uff65~!?.,:;'"()《》【】「」“”‘’_\-+*\/&#@%\p{So}\p{Sk}]/gu;

  function admitCaption(input) {
    try {
      CAPTION_PARAM_RE.lastIndex = 0;
      var stripped = String(input == null ? '' : input).replace(CAPTION_PARAM_RE, ' ');
      CAPTION_ALLOW_RE.lastIndex = 0;
      var kept = stripped.match(CAPTION_ALLOW_RE) || [];
      var text = kept.join('')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,.;:'"()\-+*\/&#@%_，、：；（）《》【】「」“”‘’]+|[\s,.;:'"()\-+*\/&#@%_，、：；（）《》【】「」“”‘’]+$/g, '')
        .trim();
      return text ? { ok: true, text: text } : { ok: false, text: '' };
    } catch (e) {
      return { ok: false, text: '' };
    }
  }

  if (typeof window !== 'undefined') {
    window.DSH_L2D_CAPTION__ = { admit: admitCaption, paramRe: CAPTION_PARAM_RE, allowRe: CAPTION_ALLOW_RE };
  }

  function say(text, holdMs) {
    if (!bubbleEl || !text) return;
    var admitted = admitCaption(text);
    if (!admitted.ok) return;
    bubbleEl.textContent = admitted.text;
    pushL2dLog({ comp: 'overlay', action: 'say', state: String(admitted.text).slice(0, 20) });
    bubbleEl.classList.add('show');
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () {
      bubbleEl.classList.remove('show');
    }, holdMs || 2600);
  }

  /** 可信 HTML 专用：只用于本插件自己构造的余额/动作气泡，不用于外部内容 */
  function sayHtml(html, holdMs) {
    if (!bubbleEl || !html) return;
    bubbleEl.innerHTML = html;
    bubbleEl.classList.add('show');
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () {
      bubbleEl.classList.remove('show');
    }, holdMs || 2600);
  }

  // ---------------------------------------------------------------- 音效
  // 优先播放 $DSH_HOME/l2d-audio/ 下的自定义音频；没有则用 WebAudio 合成「小黄鸭」声。
  // 不内置任何第三方音频文件，避免素材授权与复用问题。
  var audioCtx = null;
  var customAudio = null;
  var audioLoading = false;

  function getAudioCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        audioCtx = new AC();
      } catch (e) {
        return null;
      }
    }
    if (audioCtx.state === 'suspended') {
      try {
        audioCtx.resume();
      } catch (e) { /* ignore */ }
    }
    return audioCtx;
  }

  function loadCustomAudio() {
    if (customAudio || audioLoading) return;
    audioLoading = true;
    try {
      fetch('/dsh-l2d/audio/index.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          audioLoading = false;
          if (data && Array.isArray(data.files) && data.files.length) {
            customAudio = data.files;
          }
        })
        .catch(function () { audioLoading = false; });
    } catch (e) {
      audioLoading = false;
    }
  }

  function playCustom(kind) {
    if (!customAudio || !customAudio.length) return false;
    var pick = customAudio[Math.floor(Math.random() * customAudio.length)];
    try {
      var a = new Audio('/dsh-l2d/audio/file?name=' + encodeURIComponent(pick));
      a.volume = kind === 'press' ? 0.7 : 0.55;
      a.play().catch(function () { /* 自动播放被拦截时静默 */ });
      return true;
    } catch (e) {
      return false;
    }
  }

  // 合成鸭子叫声：锯齿波快速下滑 + 带通滤波，短促且有「嘎」的质感
  function synthQuack(kind) {
    var ctx = getAudioCtx();
    if (!ctx) return;
    var t = ctx.currentTime;
    var base = kind === 'press' ? 660 : 500;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    var filter = ctx.createBiquadFilter();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.52, t + 0.13);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1150, t);
    filter.frequency.exponentialRampToValueAtTime(780, t + 0.13);
    filter.Q.value = 3.5;

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(kind === 'press' ? 0.22 : 0.16, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.19);
  }

  function playSound(kind) {
    if (playCustom(kind)) return;
    synthQuack(kind);
  }

  // ---------------------------------------------------------------- 余额
  var balanceCache = null;
  var balanceAt = 0;

  function fetchBalance() {
    var now = Date.now();
    if (balanceCache && now - balanceAt < 30000) return Promise.resolve(balanceCache);
    return fetch('/dsh-l2d/balance.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        balanceCache = data;
        balanceAt = Date.now();
        return data;
      })
      .catch(function () { return null; });
  }

  // DeepSeek API 峰谷计费（2026-08-23 规则）：
  // 工作日 09:00-12:00 / 14:00-18:00 为峰价；其余与周末全天为谷价。
  var PEAK_PRICES = {
    pro: { input: 9, output: 27, cache: 0.3 },
    flash: { input: 3, output: 9, cache: 0.1 },
  };
  var OFF_PEAK_PRICES = {
    pro: { input: 4.5, output: 13.5, cache: 0.15 },
    flash: { input: 1.5, output: 4.5, cache: 0.05 },
  };

  function billingTier(at) {
    var date = at ? new Date(at) : new Date();
    // 用北京时间判断；本机可能不是 UTC+8
    var bj = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60000);
    var hour = bj.getHours();
    var weekday = bj.getDay() >= 1 && bj.getDay() <= 5;
    var peak = weekday && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
    return {
      peak: peak,
      weekend: !weekday,
      label: peak ? '峰价' : '谷价',
      mark: peak ? '🔴' : '🟢',
      prices: peak ? PEAK_PRICES : OFF_PEAK_PRICES,
    };
  }

  function priceHtml(label, value, colorClass) {
    return '<span class="' + colorClass + '">' + label + ' ' + value + '</span>';
  }

  function formatBalanceHtml(data, tier) {
    var t = tier || billingTier();
    if (!data) return '余额获取失败';
    if (!data.ok) {
      var miss = data.reason === 'no-key' ? '未配置 API Key' : '余额暂时不可用';
      return miss +
        '<span class="price-sub">当前计费：' + priceHtml(t.label, t.mark, t.peak ? 'price-up' : 'price-down') + '</span>';
    }
    var symbol = data.currency === 'USD' ? '$' : '¥';
    var total = typeof data.total === 'number' ? data.total.toFixed(2) : '—';
    var tierClass = t.peak ? 'price-up' : 'price-down';
    var sub =
      '<span class="price-sub">计费：' + priceHtml(t.label, t.mark, tierClass) +
      ' · V4-Pro ' + t.prices.pro.input + '/' + t.prices.pro.output +
      ' · Flash ' + t.prices.flash.input + '/' + t.prices.flash.output + '</span>' +
      '<span class="price-sub">缓存命中 V4-Pro ' + t.prices.pro.cache + ' · Flash ' + t.prices.flash.cache +
      ' 元/百万tokens' + (t.weekend ? '（周末全天谷价）' : '') + '</span>';
    return '余额 ' + symbol + total + (data.stale ? '（缓存）' : '') + sub;
  }

  function showBalance() {
    var tier = billingTier();
    fetchBalance().then(function (data) {
      // 价格放到底部专用条，不占对话框
      if (priceEl) {
        priceEl.innerHTML = formatBalanceHtml(data, tier);
        priceEl.classList.add('show');
        clearTimeout(priceEl._hideTimer);
        priceEl._hideTimer = setTimeout(function () {
          priceEl.classList.remove('show');
        }, 6500);
      }
    });
  }

  // ---------------------------------------------------------------- 体型/分区互动
  function appearanceValues(ids) {
    var L = window.DSH_L2D;
    if (!L || !L.readParameters) return {};
    return L.readParameters(ids) || {};
  }

  function setSwitch(id, value) {
    var L = window.DSH_L2D;
    if (!L) return;
    // UI 本地交互（换装/配饰开关）走 runtime 通道：不受 Node Ownership 托管白名单
    // 约束（白名单管 Agent 控制权）；旧渲染包无 runtime 入口时回退 agent 通道。
    if (L.setParametersRuntime) {
      var one = {};
      one[id] = value;
      L.setParametersRuntime(one, 1);
    } else if (L.setParameter) {
      L.setParameter(id, value, 1);
    }
    if (L.markActive) L.markActive();
  }

  function switchOn(id) {
    var value = appearanceValues([id])[id];
    return Number(value) > 0.5;
  }

  function setBodyType(index) {
    var L = window.DSH_L2D;
    if (!L || !L.setParameter) return;
    var item = BODY_TYPES[Math.max(0, Math.min(2, Number(index) || 0))];
    prefs.bodyType = Math.max(0, Math.min(2, Number(index) || 0));
    persist();
    setSwitch('Clothes2', item.value);
    applyScale(settings.scale);
    say('换好了：' + item.label, 2400);
  }

  function cycleBodyType() {
    setBodyType((Number(prefs.bodyType) || 0) + 1);
  }

  function toggleShoes() {
    var on = switchOn('Clothes4');
    setSwitch('Clothes4', on ? 0 : 1);
    say(on ? '鞋子穿好啦' : '光脚舒服～', 2600);
  }

  function friendlyHead() {
    var L = window.DSH_L2D;
    if (!L) return;
    if (L.setExpression) L.setExpression(Math.random() < 0.55 ? '兔牙' : '爱心眼');
    if (L.lookAt) L.lookAt(0, 0.24);
    say('嘿嘿，好痒~', 2600);
  }

  function shyChest() {
    var L = window.DSH_L2D;
    if (!L) return;
    if (L.setExpression) L.setExpression(Math.random() < 0.65 ? '脸红' : '＞＜');
    if (L.lookAt) L.lookAt((Math.random() - 0.5) * 0.25, -0.1);
    say('别、别乱摸啦！', 3200);
  }

  var lastPatAt = 0;

  /** 摸头（桌宠模式专用）：表情+视线+微动作占位；正式 摸头.motion3.json 到位后替换 */
  function patHead() {
    var now = Date.now();
    if (now - lastPatAt < 800) return; // 连点节流，防表情刷屏
    lastPatAt = now;
    var L = window.DSH_L2D;
    if (!L) return;
    if (L.setExpression) L.setExpression(Math.random() < 0.55 ? '兔牙' : '爱心眼');
    if (L.lookAt) L.lookAt((Math.random() - 0.5) * 0.2, 0.24);
    // 微歪头/鼓脸走情绪路由 ambient 通道（复用微动作机制，2400ms 自动回弹）；注入失败不影响表情
    if (L.injectEmotionIntent) {
      try {
        L.injectEmotionIntent({
          ruleId: 'pat-head',
          source: 'pet',
          priority: 20,
          ambient: Math.random() < 0.5 ? 'tilt' : 'puff',
          holdMs: 2400,
        });
      } catch (err) { /* ignore */ }
    }
    say(Math.random() < 0.5 ? '嘿嘿，好痒~' : '再摸头发要乱啦', 2600);
    // 反向桥上报告知宿主/DSH：用户刚摸了头（fire-and-forget，失败不影响互动）
    try {
      fetch('/dsh-l2d/reverse/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'pet', payload: { region: 'head' } }),
      }).catch(function () { /* ignore */ });
    } catch (err) { /* ignore */ }
  }

  function bodyPoint(e) {
    var rect = bodyEl.getBoundingClientRect();
    return {
      nx: (e.clientX - rect.left) / Math.max(1, rect.width),
      ny: (e.clientY - rect.top) / Math.max(1, rect.height),
      rect: rect,
    };
  }

  function zoneAt(e) {
    var p = bodyPoint(e);
    // 拖拽放大是绕画布中心缩放模型。分区仍按未缩放的身位划分，
    // 所以先把点击点除以缩放，避免放大后点到的部位错位。不依赖 model3 的 HitAreas。
    var z = dragZoom && dragZoom.cur > 0 ? dragZoom.cur : 1;
    var nx = 0.5 + (p.nx - 0.5) / z;
    var ny = 0.5 + (p.ny - 0.5) / z;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    // 分区按整身画布归一化；以实测截图校准，覆盖头/胸/裙/足四类高频互动。
    if (nx >= 0.38 && nx <= 0.68 && ny < 0.15) return 'head';
    if (nx >= 0.32 && nx <= 0.72 && ny >= 0.15 && ny < 0.37) return 'chest';
    if (nx >= 0.22 && nx <= 0.82 && ny >= 0.37 && ny < 0.66) return 'skirt';
    if (nx >= 0.28 && nx <= 0.76 && ny >= 0.66) return 'foot';
    return 'body';
  }

  function startSkirtDrag(e) {
    var startValue = appearanceValues(['Clothes1']).Clothes1;
    startValue = Number.isFinite(Number(startValue)) ? Number(startValue) : 0;
    var startY = e.clientY;
    var moved = false;

    function onMove(ev) {
      var dy = ev.clientY - startY;
      if (Math.abs(dy) > 3) moved = true;
      // 上拖 = 裙摆收短，下拖 = 放长；表达式的切换方向是 -1。
      var value = Math.max(-1, Math.min(0, startValue + Math.max(-1, Math.min(1, dy / 110))));
      setSwitch('Clothes1', value);
    }

    function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      if (Math.abs(ev.clientY - startY) > 5) {
        var value = appearanceValues(['Clothes1']).Clothes1 || 0;
        say(value < -0.5 ? '裙摆收短了' : '裙摆放长了', 2600);
        window.__DSH_L2D_SKIRT_DRAGGED__ = Date.now();
      }
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  function handleZoneClick(e) {
    // 桌宠模式：全分区只保留摸头；换鞋/害羞/戳一戳仅右键菜单可达
    if (settings.petMode === true) return patHead();
    var zone = zoneAt(e);
    if (zone === 'foot') return toggleShoes();
    if (zone === 'head') return friendlyHead();
    if (zone === 'chest') return shyChest();
    return pokeAction();
  }

  // ---------------------------------------------------------------- 右键菜单
  // 外观调整全部收进「模型外观」子菜单，避免与拖拽/分区手势冲突。
  var menuView = 'root';
  var appearanceCurrent = null; // 当前外观表情名；null = 默认
  var FACE_OPTIONS = ['兔牙', '脸红', '爱心眼', '黑脸', '＞＜', '加载', '屑', '圈圈眼'];
  var APPEARANCE_OPTIONS = [];
  // 衣着/饰品改走 accessories 表（物品 → 饰品），不再在外观菜单硬编码。
  var yandereOn = false;
  var yandereArmedAt = 0;
  var yandereFx = null;
  var yandereActRunId = 0;


  // ---- 饰品：读 body-regions.json accessories（经 catalog），薄适配层 ----
  // 替换点：若 window.DSH_L2D.applyAccessoryToggle 存在（bridge 饰品层），优先走它。
  var accessoryTable = { slots: [], loaded: false, loading: false };

  function accessoryItemParam(item) {
    if (!item) return '';
    if (item.writesParam) return String(item.writesParam);
    if (item.kind === 'param' && item.ref) return String(item.ref);
    return '';
  }

  function isAccessoryOn(value, item) {
    if (!item) return false;
    var current = Number(value);
    var on = Number(item.on);
    var off = Number(item.off);
    if (!isFinite(current) || !isFinite(on) || !isFinite(off)) return false;
    return Math.abs(current - on) < Math.abs(current - off);
  }

  function planAccessoryToggle(slot, item, wantOn) {
    var values = {};
    if (!item) return { values: values, on: !!wantOn };
    var param = accessoryItemParam(item);
    if (param) values[param] = wantOn ? item.on : item.off;
    if (wantOn && slot && slot.exclusive === true && Array.isArray(slot.items)) {
      slot.items.forEach(function (other) {
        if (!other || other.id === item.id) return;
        var otherParam = accessoryItemParam(other);
        if (otherParam && values[otherParam] === undefined) values[otherParam] = other.off;
      });
    }
    return { values: values, itemId: item.id, slotId: slot && slot.id, kind: item.kind, ref: item.ref, on: !!wantOn };
  }

  function applyAccessoryPlan(plan) {
    var L = window.DSH_L2D;
    if (L && typeof L.applyAccessoryToggle === 'function') return L.applyAccessoryToggle(plan);
    if (!plan || !plan.values) return;
    if (L && L.setParametersRuntime) L.setParametersRuntime(plan.values, 1);
    else {
      Object.keys(plan.values).forEach(function (id) { setSwitch(id, plan.values[id]); });
      return;
    }
    if (L && L.markActive) L.markActive();
  }

  function loadAccessoryTable(then) {
    if (accessoryTable.loading) return;
    accessoryTable.loading = true;
    fetch('/dsh-l2d/api/nodegraph/catalog', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var slots = data && data.accessories && Array.isArray(data.accessories.slots) ? data.accessories.slots : [];
        accessoryTable.slots = slots.filter(function (slot) {
          return slot && Array.isArray(slot.items) && slot.items.length > 0;
        });
        accessoryTable.loaded = true;
        accessoryTable.loading = false;
        if (typeof then === 'function') then();
      })
      .catch(function () {
        accessoryTable.loaded = true;
        accessoryTable.loading = false;
        if (typeof then === 'function') then();
      });
  }

  function buildAccessoryMenu() {
    if (!accessoryTable.loaded) {
      menuEl.appendChild(menuButton('加载饰品…', function () {}, true));
      loadAccessoryTable(function () { setTimeout(function () { buildMenu(); if (menuEl && menuEl.classList.contains('open')) placeMenu(); }, 30); });
      return;
    }
    if (!accessoryTable.slots.length) {
      var empty = document.createElement('div');
      empty.className = 'l2d-acc-empty';
      empty.textContent = '还没有可切换的饰品分组';
      menuEl.appendChild(empty);
      return;
    }
    accessoryTable.slots.forEach(function (slot) {
      var head = document.createElement('div');
      head.className = 'l2d-acc-slot-label';
      head.textContent = slot.label || slot.id;
      menuEl.appendChild(head);
      var row = document.createElement('div');
      row.className = 'l2d-acc-row';
      row.setAttribute('role', 'list');
      (slot.items || []).forEach(function (item) {
        var param = accessoryItemParam(item);
        var current = param ? appearanceValues([param])[param] : undefined;
        var on = isAccessoryOn(current, item);
        var btn = menuButton(item.label || item.id, function () {
          applyAccessoryPlan(planAccessoryToggle(slot, item, !on));
          setTimeout(buildMenu, 30);
        }, true);
        btn.setAttribute('role', 'listitem');
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) btn.setAttribute('data-state', 'selected');
        row.appendChild(btn);
      });
      menuEl.appendChild(row);
    });
  }

  function applyAppearance(name) {
    var L = window.DSH_L2D;
    if (!L) return;
    try {
      if (name) {
        if (L.setExpression) L.setExpression(name);
        appearanceCurrent = name;
      } else {
        if (L.clearExpression) L.clearExpression();
        appearanceCurrent = null;
      }
    } catch (e) {
      /* ignore */
    }
  }

  function setYandereFx(on) {
    if (on && !yandereFx) {
      yandereFx = document.createElement('div');
      yandereFx.className = 'l2d-yandere-fx';
      document.body.appendChild(yandereFx);
    }
    if (yandereFx) yandereFx.classList[on ? 'add' : 'remove']('on');
  }

  function enableYandere() {
    yandereOn = true;
    var L = window.DSH_L2D;
    // 9 秒 FORCE 只保护开场不被待机打断。到点或被同级抢走都不会关掉邪神。
    // 「抚胸手关闭」记进 pendingCloses，和别的收招走同一条 closesToFlush。
    var held = executePokeAction({
      priority: 'FORCE',
      source: 'yandere',
      silent: true,
      holdOnly: true,
      holdMs: 9000,
    });
    yandereActRunId = held && held.accepted ? held.runId : 0;
    if (yandereActRunId) scheduleCloseMotion('抚胸手关闭', 8000, yandereActRunId);
    try {
      if (L && L.injectEmotionIntent) {
        L.injectEmotionIntent({
          ruleId: 'yandere-mode',
          source: 'menu',
          priority: 95,
          expression: '黑脸',
          motion: '抚胸手打开',
          pose: { right: 'finger' },
          look: { x: 0, y: 0.35 },
          bubble: '(ÒωÓ) 让我看看用户硬盘里有什么好东西',
          holdMs: 9000,
        });
      } else {
        applyAppearance('黑脸');
        if (L && L.playMotionAsync) L.playMotionAsync('抚胸手打开');
        say('(ÒωÓ) 让我看看用户硬盘里有什么好东西', 6000);
      }
    } catch (e) {
      /* ignore */
    }
    setYandereFx(true);
  }

  // 只有菜单关闭才走完整收尾。槽被抢走或 9 秒开场结束都不进这里，暗角和黑脸留着。
  // resetPerformance 清表情、注视和姿势。抚胸手用 interrupt，避免开场动作还占着状态机时被吞掉。
  function exitYandereVisual() {
    yandereOn = false;
    yandereArmedAt = 0;
    appearanceCurrent = null;
    yandereActRunId = 0;
    var L = window.DSH_L2D;
    try {
      if (L && L.resetPerformance) L.resetPerformance();
      if (L && L.playMotionAsync) {
        L.playMotionAsync('抚胸手关闭', { interrupt: true }).catch(function () { /* 本来就没打开 */ });
      }
    } catch (e) {
      /* 复位失败也要把屏幕特效关掉 */
    }
    setYandereFx(false);
    setTimeout(buildMenu, 30);
  }

  function disableYandere() {
    var runId = yandereActRunId;
    if (runId) releaseActRun(runId, 'yandere-off');
    exitYandereVisual();
    say('…什么都没看到。', 3000);
  }

  function closeMenu() {
    if (!menuEl) return;
    menuEl.classList.remove('open');
    menuEl.setAttribute('aria-hidden', 'true');
  }

  function menuButton(text, onClick, keepOpen) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!keepOpen) closeMenu();
      onClick();
    });
    return btn;
  }

  function buildMenu() {
    if (!menuEl) return;
    menuEl.innerHTML = '';
    var title = document.createElement('div');
    title.className = 'l2d-menu-title';
    title.textContent = menuView === 'root' ? 'DSH-L2D' : menuView === 'quickchat' ? '快捷对话' : menuView === 'appearance' ? '模型外观' : menuView === 'accessories' ? '饰品' : '面部';
    menuEl.appendChild(title);

    if (menuView === 'quickchat') {
      menuEl.appendChild(menuButton('← 返回', function () {
        menuView = 'root';
        setTimeout(buildMenu, 30);
      }, true));
      buildQuickChat();
      if (menuEl.classList.contains('open')) placeMenu();
      return;
    }

    if (menuView === 'accessories') {
      menuEl.appendChild(menuButton('← 返回', function () {
        menuView = 'root';
        setTimeout(buildMenu, 30);
      }, true));
      buildAccessoryMenu();
      if (menuEl.classList.contains('open')) placeMenu();
      return;
    }

    if (menuView === 'appearance') {
      menuEl.appendChild(menuButton('← 返回', function () {
        menuView = 'root';
        setTimeout(buildMenu, 30);
      }, true));
      var faceLabel = '面部' + (appearanceCurrent && FACE_OPTIONS.indexOf(appearanceCurrent) >= 0 ? '（✓ ' + appearanceCurrent + '）' : '');
      menuEl.appendChild(menuButton(faceLabel, function () {
        menuView = 'face';
        setTimeout(buildMenu, 30);
      }, true));
      for (var ai = 0; ai < APPEARANCE_OPTIONS.length; ai++) {
        (function (opt) {
          var mark = appearanceCurrent === opt.name ? '（✓）' : '';
          menuEl.appendChild(menuButton(opt.label + mark, function () {
            applyAppearance(appearanceCurrent === opt.name ? null : opt.name);
            setTimeout(buildMenu, 30);
          }, true));
        })(APPEARANCE_OPTIONS[ai]);
      }
      menuEl.appendChild(menuButton('恢复默认外观', function () {
        applyAppearance(null);
        setTimeout(buildMenu, 30);
      }, true));
      if (menuEl.classList.contains('open')) placeMenu();
      return;
    }

    if (menuView === 'face') {
      menuEl.appendChild(menuButton('← 返回', function () {
        menuView = 'appearance';
        setTimeout(buildMenu, 30);
      }, true));
      for (var fi = 0; fi < FACE_OPTIONS.length; fi++) {
        (function (name) {
          var mark = appearanceCurrent === name ? '（✓）' : '';
          menuEl.appendChild(menuButton(name + mark, function () {
            applyAppearance(name);
            setTimeout(buildMenu, 30);
          }, true));
        })(FACE_OPTIONS[fi]);
      }
      menuEl.appendChild(menuButton('恢复默认脸', function () {
        applyAppearance(null);
        setTimeout(buildMenu, 30);
      }, true));
      if (menuEl.classList.contains('open')) placeMenu();
      return;
    }

    menuEl.appendChild(menuButton('设置', function () { openSettingsDrawer(); }));
    menuEl.appendChild(menuButton('对话', function () {
      var agent = window.__DSH_L2D_AGENT__ || {};
      var text = trimChatText(agent.lastAssistantText, 70) || '我在听，你说吧～';
      say(text, 5200);
      if (window.DSH_L2D && window.DSH_L2D.setExpression) window.DSH_L2D.setExpression('兔牙');
    }));
    menuEl.appendChild(menuButton('随机动作', pokeRandom));
    menuEl.appendChild(menuButton('物品', function () {
      menuView = 'accessories';
      setTimeout(buildMenu, 30);
    }, true));
    menuEl.appendChild(menuButton('模型外观', function () {
      menuView = 'appearance';
      setTimeout(buildMenu, 30);
    }, true));
    menuEl.appendChild(
      menuButton(
        yandereOn
          ? '关闭邪神模式'
          : yandereArmedAt && Date.now() - yandereArmedAt < 6000
            ? '⚠ 再点一次确认开启'
            : '邪神模式（勿点）',
        function () {
          if (yandereOn) return disableYandere();
          if (yandereArmedAt && Date.now() - yandereArmedAt < 6000) {
            yandereArmedAt = 0;
            enableYandere();
            setTimeout(buildMenu, 30);
          } else {
            yandereArmedAt = Date.now();
            say('真的要开吗？再点一次确认', 4000);
            setTimeout(buildMenu, 30);
          }
        },
        true
      )
    );
    var bodyLabel = (BODY_TYPES[Number(prefs.bodyType) || 0] || BODY_TYPES[0]).label;
    menuEl.appendChild(menuButton('切换体型（' + bodyLabel + '）', function () {
      cycleBodyType();
      setTimeout(buildMenu, 30);
    }));
    menuEl.appendChild(menuButton('余额 / 价格', showBalance));
    menuEl.appendChild(menuButton('快捷对话', function () {
      menuView = 'quickchat';
      setTimeout(buildMenu, 30);
    }, true));
    menuEl.appendChild(menuButton('调试日志', toggleLogPanel, true));
    if (menuEl.classList.contains('open')) placeMenu();
  }

  // ---- 快捷对话：Enter 发送 / Shift+Enter 换行；发送成功本地经字幕准入回显并关菜单 ----
  var qcSending = false;

  function buildQuickChat() {
    var wrap = document.createElement('div');
    wrap.className = 'l2d-qc';
    var input = document.createElement('textarea');
    input.className = 'l2d-qc-input';
    input.rows = 1;
    input.placeholder = '想对角色说什么…';
    var autoHeight = function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };
    input.addEventListener('input', autoHeight);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeMenu(); return; } // Esc 关菜单，其余按键不外泄
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendQuickChat(input);
      }
    });
    var sendBtn = menuButton('发送', function () { sendQuickChat(input); }, true);
    sendBtn.className = 'l2d-qc-send';
    var hint = document.createElement('div');
    hint.className = 'l2d-qc-hint';
    hint.textContent = 'Enter 发送 · Shift+Enter 换行 · 最多 200 字';
    wrap.appendChild(input);
    wrap.appendChild(sendBtn);
    wrap.appendChild(hint);
    menuEl.appendChild(wrap);
    setTimeout(function () {
      try { input.focus(); } catch (err) { /* ignore */ }
      autoHeight();
    }, 40);
  }

  function sendQuickChat(input) {
    if (qcSending) return; // 禁止并发重入
    var text = String((input && input.value) || '').trim();
    if (!text) return;
    if (text.length > 200) {
      text = text.slice(0, 200); // 与 l2d_say 的 slice(0,200) 对齐，超出前端先截断并提示
      input.value = text;
      var hintEl = menuEl && menuEl.querySelector('.l2d-qc-hint');
      if (hintEl) hintEl.textContent = '太长了，已截断到 200 字';
      say('太长了，只发前 200 字', 2200);
    }
    qcSending = true;
    fetch('/dsh-l2d/ai/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'l2d_say', args: { text: text, holdMs: 5200 } }),
      cache: 'no-store',
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().catch(function () { return {}; });
      })
      .then(function (queued) {
        if (!queued || typeof queued.id === 'undefined') throw new Error('no-queue-id');
        qcSending = false;
        if (input) input.value = '';
        say(text, 5200); // 本地直接回显（经字幕准入）；后端消费 l2d_say 后同文再上屏一次
        closeMenu();
      })
      .catch(function () {
        qcSending = false;
        say('发送失败，再试一次', 2200); // 失败不关菜单，保留输入便于重试
      });
  }

  // ---- 调试日志面板：固定右上角小窗，开/关切换；关闭后缓冲继续记录 ----
  var logPanelEl = null;
  var logLinesEl = null;

  function ensureLogPanel() {
    if (logPanelEl) return;
    logPanelEl = document.createElement('div');
    logPanelEl.className = 'l2d-logpanel';
    logPanelEl.setAttribute('aria-hidden', 'true');
    var head = document.createElement('div');
    head.className = 'l2d-logpanel-head';
    var headTitle = document.createElement('span');
    headTitle.textContent = '调试日志';
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '清空';
    clearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      l2dLogEntries.length = 0;
      renderLogPanel();
    });
    head.appendChild(headTitle);
    head.appendChild(clearBtn);
    logLinesEl = document.createElement('div');
    logLinesEl.className = 'l2d-logpanel-body';
    logPanelEl.appendChild(head);
    logPanelEl.appendChild(logLinesEl);
    document.body.appendChild(logPanelEl);
  }

  function renderLogPanel() {
    if (!logPanelEl || !logLinesEl) return;
    var lines = renderL2dLog();
    logLinesEl.textContent = '';
    for (var i = 0; i < lines.length; i++) {
      var row = document.createElement('div');
      row.className = 'l2d-logline';
      row.textContent = lines[i];
      logLinesEl.appendChild(row);
    }
    logLinesEl.scrollTop = logLinesEl.scrollHeight; // 最新在底自动滚动
  }

  function toggleLogPanel() {
    ensureLogPanel();
    var show = !logPanelEl.classList.contains('open');
    logPanelEl.classList.toggle('open', show);
    logPanelEl.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) renderLogPanel();
  }

  var lastMenuX = 8;
  var lastMenuY = 8;

  function placeMenu(x, y) {
    if (!menuEl) return;
    var pad = 8;
    if (typeof x === 'number') lastMenuX = x;
    if (typeof y === 'number') lastMenuY = y;
    var maxH = Math.max(160, window.innerHeight - pad * 2);
    menuEl.style.maxHeight = maxH + 'px';
    var w = menuEl.offsetWidth || 160;
    var h = menuEl.offsetHeight || 180;
    var left = Math.min(window.innerWidth - w - pad, Math.max(pad, lastMenuX));
    var top = Math.min(window.innerHeight - h - pad, Math.max(pad, lastMenuY));
    var avail = window.innerHeight - pad - top;
    if (h > avail) {
      menuEl.style.maxHeight = Math.max(160, avail) + 'px';
      h = menuEl.offsetHeight || avail;
      if (h > avail) {
        top = Math.max(pad, window.innerHeight - h - pad);
        menuEl.style.maxHeight = Math.max(160, window.innerHeight - pad - top) + 'px';
      }
    }
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
  }

  function openMenuAt(e) {
    buildMenu();
    if (!menuEl) return;
    menuEl.classList.add('open');
    menuEl.setAttribute('aria-hidden', 'false');
    placeMenu(e.clientX, e.clientY);
  }

  function moodFromText(text) {
    var raw = String(text || '');
    var tag = /<mood>([^<]+)<\/mood>/.exec(raw);
    if (tag && tag[1].trim()) return tag[1].trim();
    if (/(开心|高兴|哈哈|太好了|喜欢)/.test(raw)) return '开心';
    if (/(害羞|不好意思|脸红)/.test(raw)) return '害羞';
    if (/(生气|愤怒|讨厌)/.test(raw)) return '生气';
    if (/(惊讶|不会吧|震惊|哇)/.test(raw)) return '惊讶';
    if (/(难过|伤心|抱歉|对不起)/.test(raw)) return '悲伤';
    if (/(爱你|么么|心心)/.test(raw)) return '爱';
    if (/(思考|为什么|分析|让我想想|如何)/.test(raw)) return '思考';
    return '';
  }

  function chatActionForReply(text) {
    var t = String(text || '');
    var chain = [];
    function add(step) { chain.push(step); }

    if (/(你好|hello|hi|在吗|早上好|晚上好|我回来了|嗨)/i.test(t)) {
      add({ kind: 'expression', name: '兔牙' });
      add({ kind: 'motion', name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 4200, delayMs: 120 });
    } else if (/(谢谢|感谢|辛苦|厉害|great|done|完成|成功|修复)/i.test(t)) {
      add({ kind: 'expression', name: '兔牙' });
      add({ kind: 'pose', pose: { right: 'finger' }, delayMs: 120 });
    } else if (/(对不起|抱歉|失败|错误|error|failed|异常)/i.test(t)) {
      add({ kind: 'expression', name: '流冷汗' });
      add({ kind: 'pose', pose: { right: 'rest', left: 'chest' }, delayMs: 120 });
    } else if (/(为什么|怎么|如何|是否|吗？|\?|思考|分析|看看)/.test(t)) {
      add({ kind: 'expression', name: '加载' });
      add({ kind: 'look', x: 0.18, y: 0.22, delayMs: 80 });
    } else if (/(哈哈|笑死|乐|草|梗|好玩)/i.test(t)) {
      add({ kind: 'expression', name: '＞＜' });
      add({ kind: 'pose', pose: { right: 'grass' }, delayMs: 120 });
    } else if (/(抱抱|摸摸|喜欢|爱你|可爱)/i.test(t)) {
      add({ kind: 'expression', name: '脸红' });
      add({ kind: 'pose', pose: { right: 'rest', left: 'chest' }, delayMs: 120 });
    } else {
      add({ kind: 'expression', name: Math.random() < 0.5 ? '兔牙' : '加载' });
      add({ kind: 'look', x: (Math.random() - 0.5) * 0.4, y: Math.random() * 0.2, delayMs: 100 });
    }
    return {
      chain: chain,
      bubble: '',
      silent: true,
      priority: 'FORCE',
      source: 'dialogue',
      holdMs: 4500,
    };
  }

  // 调试/自动化测试钩子：不进 AI 工具白名单
  // 设置窗口管理钩子：供全局设置入口（lib/settings-entry.js）的
  // SettingsWindowManager 调用。单实例语义：已开则聚焦+锚到分组，不重复创建。
  function focusPanelWindow() {
    if (!panelEl || !panelOpen) return;
    var head = panelEl.querySelector('.l2d-panel-head');
    if (head && head.focus) head.focus({ preventScroll: true });
  }
  function focusPanelGroup(group) {
    if (!panelEl || !panelOpen || !group) return;
    var target = panelEl.querySelector('.l2d-row[data-group="' + String(group).replace(/"/g, '') + '"]');
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('l2d-group-flash');
    // 触发重绘以重放高亮
    void target.offsetWidth;
    target.classList.add('l2d-group-flash');
    setTimeout(function () { target.classList.remove('l2d-group-flash'); }, 1400);
  }
  window.DSH_L2D_UI = {
    chatActionForReply: chatActionForReply,
    executePokeAction: executePokeAction,
    enableYandere: enableYandere,
    disableYandere: disableYandere,
    setBodyType: setBodyType,
    cycleBodyType: cycleBodyType,
    zoneAt: zoneAt,
    settings: {
      // 旧内嵌面板已退役（Settings-UI.md §8.3）：设置入口统一改向新设置页抽屉。
      // 保留 API 形状（open(group)/close/focus/isOpen），group 语义 = 新页分区 sec-*。
      open: function (group) { openSettingsDrawer(group); },
      close: function () {
        var m = window.DSH_L2D_SettingsWindowManager;
        if (m && m.close) m.close();
      },
      focus: function () {
        var m = window.DSH_L2D_SettingsWindowManager;
        if (m && m.focus) m.focus();
      },
      isOpen: function () {
        var m = window.DSH_L2D_SettingsWindowManager;
        return !!(m && m.isOpen && m.isOpen());
      },
    },
    // 动作池读库（UI-FLOAT ⑤）调试/自动化钩子：不进 AI 工具白名单
    pokeRandom: pokeRandom,
    dbActions: function () {
      if (dbActionRaw.length && !dbActionPoolBuilt) buildDbPool();
      return { raw: dbActionRaw.length, pool: dbActionPool.length };
    },
    dbChainPreview: function (index) {
      if (dbActionRaw.length && !dbActionPoolBuilt) buildDbPool();
      var item = dbActionPool[Number(index) || 0];
      return item ? JSON.parse(JSON.stringify(item.chain)) : null;
    },
    pokeDbAction: function (index) {
      if (dbActionRaw.length && !dbActionPoolBuilt) buildDbPool();
      var item = dbActionPool[Number(index) || 0];
      if (!item) return { ok: false, accepted: false, reason: 'no-db-chain' };
      return executePokeAction({
        priority: 'FORCE',
        source: 'poke-db',
        callId: item.chainId,
        silent: true,
        chain: item.chain,
      });
    },
    actState: function () {
      var L = window.DSH_L2D;
      return L && L.currentAct ? L.currentAct() : null;
    },
  };

  // ---------------------------------------------------------------- 拖动
  // ---------------------------------------------------------------- 拖拽物理
  //
  // 目标：拖动「过程中」就有重量感 —— 容器跟手走，但角色的头/身因为惯性滞后，
  //       速度越快偏得越多，停下再回正。松手后额外叠一段阻尼回弹。
  //
  // 关键实现点：参数写入必须挂在 setPreUpdate 上。
  // Cubism 每帧是 loadParameters → motion → saveParameters → update，
  // 在普通 rAF 里写参数很可能落在 saveParameters 之后，下一帧就被原值覆盖，
  // 表现就是「写了参数但模型完全不动」。
  var physics = {
    dragging: false,
    vx: 0,            // 拖动速度 px/s
    vy: 0,
    leanZ: 0,         // 当前侧倾（已平滑，归一化）
    posX: 0,          // 位移惯性（归一化）
    posY: 0,
    lookX: 0,
    lookY: 0,
    swing: null,      // 松手后的回弹参数
    lastMoveAt: 0,    // 最后一次 pointermove 的时间
    bound: false,
  };

  // ---------------------------------------------------------------- 物理驱动参数解析
  //
  // 这个模型的 physics3.json 是关键：
  //   131 组物理，输入是 AngleX / AngleY / AngleZ / PositionX / PositionY / LeanInput 等，
  //   输出是 ParamAngleX/Y/Z、ParamBodyAngleX/Y/Z、HipAngleX/Y/Z…
  // 也就是说 ParamAngle* 是「物理算出来的结果」，直接写会被每帧覆盖。
  // 只有写「安全的输入参数」，物理才会把惯性传导到头发、肩、裙摆、四肢。
  var physParams = null;

  function resolvePhysParams() {
    if (physParams) return true;
    var L = window.DSH_L2D;
    if (!L || !L.isReady || !L.isReady()) return false;
    var cap = L.getCapabilities ? L.getCapabilities() : null;
    if (!cap || !cap.params) return false;

    var byId = {};
    for (var i = 0; i < cap.params.length; i++) {
      byId[cap.params[i].id] = cap.params[i];
    }
    physParams = {
      angleZ: byId['AngleZ'] || byId['ParamAngleZ'] || null,
      posX: byId['PositionX'] || null,
      posY: byId['PositionY'] || null,
    };
    return !!(physParams.angleZ || physParams.posX || physParams.posY);
  }

  /** 归一化值（-1..1）→ 参数实际值，以默认值为中点 */
  function normToValue(param, n) {
    if (!param) return 0;
    var v = n >= 0 ? param.def + (param.max - param.def) * n : param.def + (param.def - param.min) * n;
    return Math.max(param.min, Math.min(param.max, v));
  }

  var clampUnit = function (v) {
    return v < -1 ? -1 : v > 1 ? 1 : v;
  };

  /** 每帧物理：窗口弹簧速度 → 轻微侧倾/位移惯性，交给模型物理传导到头发四肢。 */
  function physicsTick() {
    var L = window.DSH_L2D;
    if (!L || !L.setParameters || !L.isReady || !L.isReady()) return;

    var now = performance.now();

    // 拖拽按住但长时间没动时自然回正，兜底 pointerup 丢失
    if (physics.dragging && now - physics.lastMoveAt > 600) {
      physics.dragging = false;
      physics.vx = 0;
      physics.vy = 0;
    }

    var targetLean = 0;
    var targetPosX = 0;
    var targetPosY = 0;
    var targetLookX = 0;
    var targetLookY = 0;

    if (physics.dragging || spring.active) {
      // 幅度刻意收小；弹簧速度是有界的，不会把角色甩出去。
      targetLean = clampUnit(-spring.vx / 1100) * 0.38;
      targetPosX = pos.x === null || spring.x === null ? 0 : clampUnit((pos.x - spring.x) / 70) * 0.35;
      targetPosY = pos.y === null || spring.y === null ? 0 : clampUnit((pos.y - spring.y) / 70) * 0.25;
      targetLookX = clampUnit(spring.vx / 1200) * 0.35;
      targetLookY = clampUnit(-spring.vy / 1400) * 0.22;
    }

    var kBody = physics.dragging ? 0.16 : 0.10;
    var kHead = physics.dragging ? 0.34 : 0.16;
    physics.leanZ += (targetLean - physics.leanZ) * kBody;
    physics.posX += (targetPosX - physics.posX) * kBody;
    physics.posY += (targetPosY - physics.posY) * kBody;
    physics.lookX += (targetLookX - physics.lookX) * kHead;
    physics.lookY += (targetLookY - physics.lookY) * kHead;

    var active =
      physics.dragging ||
      spring.active ||
      Math.abs(physics.leanZ) > 0.004 ||
      Math.abs(physics.posX) > 0.004 ||
      Math.abs(physics.posY) > 0.004 ||
      Math.abs(physics.lookX) > 0.004 ||
      Math.abs(physics.lookY) > 0.004;
    if (!active) return;

    if (!resolvePhysParams()) return;

    var vals = {};
    if (physParams.angleZ) vals[physParams.angleZ.id] = normToValue(physParams.angleZ, physics.leanZ);
    if (physParams.posX) vals[physParams.posX.id] = normToValue(physParams.posX, physics.posX);
    if (physParams.posY) vals[physParams.posY.id] = normToValue(physParams.posY, physics.posY);
    // UI 本地拖拽走 runtime 通道：不受 Node Ownership 托管白名单约束（白名单管
    // Agent 控制权）；旧渲染包无 runtime 入口时回退 agent 通道。
    if (L.setParametersRuntime) L.setParametersRuntime(vals);
    else L.setParameters(vals);
    // 头部朝向已交给 gaze（眼神/躯体跟随）统一处理，这里不再双写 AngleX/Y
  }

  function bindPhysics() {
    if (physics.bound) return;
    var L = window.DSH_L2D;
    if (!L || !L.setPreUpdate) return;
    L.setPreUpdate(physicsTick);
    physics.bound = true;
  }

  // ---------------------------------------------------------------- 命中判定（alpha 采样）
  // 渲染包每帧把光标点的 alpha 缓存下来（readPixels 必须紧跟渲染）。
  // 只有真点在模型像素上才拦事件；空白处完全放行，鼠标直接透过到下层页面。
  function feedHitProbe(e) {
    var L = window.DSH_L2D;
    if (L && L.setHitProbe) {
      try { L.setHitProbe(e.clientX, e.clientY); } catch (err) { /* ignore */ }
    }
  }

  function overModel(e) {
    // Fix #40：命中判定的 fail-open 缺口。渲染包 hitTestAt 对「没采样过的点」
    // 一律返回 true（!hasSample → true），鼠标静止后的第一次按下、程序化 click
    // 都拿不到样本——旧实现无条件信任它，页面任意位置的 pointerdown 都会被当成
    // 「命中模型」启动拖拽+指针捕获，之后的鼠标移动会把容器拖走（clamp 下界
    // y=0、x≥-0.35w 正好是左上角部分出屏），换装按钮点击也被劫持成戳一戳。
    // 修复分两层，不动渲染包：
    // ① 容器矩形外必无模型像素，直接判否，不受探针语义影响；
    // ② 有渲染包时先用同步、fail-closed 的包围盒 hitTestBox 预筛（与右键菜单
    //    overModelRightClick 同一套语义），点不在模型包围盒内判否；剩下的再交给
    //    alpha 精确判定。探针 fail-open 的 true 只可能落在包围盒内，不再外溢。
    if (root) {
      var rr = root.getBoundingClientRect();
      if (e.clientX < rr.left || e.clientX > rr.right || e.clientY < rr.top || e.clientY > rr.bottom) {
        return false;
      }
    }
    var L = window.DSH_L2D;
    if (!L || !L.hitTestAt) return true; // 旧渲染包/静态兜底：容器矩形内保持整盒可交互
    if (L.hitTestBox) {
      try {
        if (!L.hitTestBox(e.clientX, e.clientY)) return false;
      } catch (errBox) { /* 包围盒不可用时退回 alpha 判定 */ }
    }
    try { return !!L.hitTestAt(e.clientX, e.clientY); } catch (err) { return true; }
  }

  /**
   * 右键菜单的命中判定必须同步：contextmenu 紧跟 pointerdown 触发，
   * alpha 采样（每帧一次）来不及更新，旧实现拿旧样本或「无样本兜底 true」，
   * 结果就是全屏右键都弹菜单（用户实测）。有渲染包走同步包围盒；
   * 静态立绘兜底时按图片元素的实际显示矩形判定。
   */
  function overModelRightClick(e) {
    var L = window.DSH_L2D;
    if (L && L.hitTestBox) {
      try { return !!L.hitTestBox(e.clientX, e.clientY); } catch (err) { /* 落到静态判定 */ }
    }
    if (imgEl && imgEl.offsetParent !== null) {
      var r = imgEl.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) {
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      }
    }
    return false;
  }

  function isL2dUiTarget(t) {
    if (!t || !t.closest) return false;
    return !!t.closest('.l2d-chip,.l2d-price,.l2d-menu,.l2d-panel,.l2d-bubble,.l2d-gear');
  }

  // 最近一次「拖动结束」的时间戳：拖动后的那次 click 不下传页面，
  // 避免拖完松手误触下层元素（穿透模式下 click 本会落到页面）。
  var lastDragMovedAt = 0;

  function bindDrag() {
    var dragging = false;
    var startX = 0;
    var startY = 0;
    var startPosX = 0;
    var startPosY = 0;
    var moved = false;

    // 速度采样
    var lastX = 0;
    var lastY = 0;
    var lastT = 0;
    var vx = 0;
    var vy = 0;

    // pointermove 一秒可能触发上百次。事件里只记录数值，
    // 真正「改 transform + 写角色参数」合并到每帧一次（rAF），
    // 否则每个事件都写样式会让主线程排队，拖动会明显发涩。
    var pendingX = 0;
    var pendingY = 0;
    var rafPending = false;

    function flushFrame() {
      rafPending = false;
      if (!dragging || !root) return;
      // 逻辑目标跟手，渲染位置由临界阻尼弹簧收敛，形成稳定滞后惯性。
      pos.x = pendingX;
      pos.y = pendingY;
      ensureSpringLoop();
      if (window.DSH_L2D && window.DSH_L2D.markActive) window.DSH_L2D.markActive();
    }

    window.addEventListener('pointerdown', function (e) {
      if (!root) return;
      if (isL2dUiTarget(e.target)) return;
      if (e.button !== 0) return;
      feedHitProbe(e);
      // 点击前强制采样一次：hover 采样已降到 10Hz，点击点可能还没轮到
      try {
        var Lp = window.DSH_L2D;
        if (Lp && Lp.requestHitSample) Lp.requestHitSample();
      } catch (errP) { /* ignore */ }
      if (!overModel(e)) return; // 空白处：不拦，事件照常落到下层页面
      e.stopPropagation(); // 命中模型：不传给下层界面
      // 裙摆拖拽手势取消：衣着只走右键菜单（点击/拖动位置冲突太多）

      loadCustomAudio();
      playSound('press');
      if (pos.x === null) applyPos(); // 首次交互先落实初始位置

      dragging = true;
      moved = false;
      bindPhysics(); // 确保每帧物理钩子已挂上
      physics.dragging = true;
      physics.vx = 0;
      physics.vy = 0;
      physics.lastMoveAt = performance.now();
      startX = e.clientX;
      startY = e.clientY;
      startPosX = pos.x;
      startPosY = pos.y;
      pendingX = pos.x;
      pendingY = pos.y;
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = performance.now();
      vx = 0;
      vy = 0;
      bodyEl.classList.add('dragging');
      if (window.DSH_L2D && window.DSH_L2D.markActive) window.DSH_L2D.markActive();
      try {
        bodyEl.setPointerCapture(e.pointerId);
      } catch (err) { /* ignore */ }
    });

    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;

      var now = performance.now();
      var dt = Math.max(1, now - lastT) / 1000;

      // 瞬时速度要先限幅再平滑：掉帧或事件合并会让 dt 变得极小，
      // 算出来的速度能到十万 px/s，直接喂给物理会让角色瞬间甩飞。
      var rawVx = (e.clientX - lastX) / dt;
      var rawVy = (e.clientY - lastY) / dt;
      rawVx = Math.max(-4000, Math.min(4000, rawVx));
      rawVy = Math.max(-4000, Math.min(4000, rawVy));

      // 指数平滑，避免单帧抖动被当成甩动
      vx = vx * 0.6 + rawVx * 0.4;
      vy = vy * 0.6 + rawVy * 0.4;
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = now;

      var c = clampPos(startPosX + dx, startPosY + dy);
      pendingX = c.x;
      pendingY = c.y;
      // 速度直接交给物理层：拖得越快，身体滞后越明显
      physics.vx = vx;
      physics.vy = vy;
      physics.lastMoveAt = performance.now();

      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(flushFrame);
      }
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      rafPending = false;
      if (bodyEl) bodyEl.classList.remove('dragging');
      if (!moved) playSound('release');
      if (moved) lastDragMovedAt = Date.now();

      // 惯性恢复：松手不追加初速度；弹簧带着当前速度收敛到松手点，不超调不飞走。
      if (moved) {
        pos.x = pendingX;
        pos.y = pendingY;
        ensureSpringLoop();
      }
      prefs.left = Math.round(pos.x);
      prefs.top = Math.round(pos.y);
      persist();
      physics.dragging = false;
      physics.vx = 0;
      physics.vy = 0;
      // 位置变了 → 注视锚点跟着变，用最后指针位置重算一次，避免旧目标错位
      reanchorGaze();
      if (moved && e && e.preventDefault) e.preventDefault();
    }

    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
    window.addEventListener('blur', endDrag);

    // 窗口尺寸变化时直接吸附；缩放/换体型不做“慢慢滑回”。
    window.addEventListener('resize', function () {
      if (pos.x === null) return;
      var c = clampPos(pos.x, pos.y);
      pos.x = c.x;
      pos.y = c.y;
      snapSpringToTarget();
      reanchorGaze();
    });
  }

  // ---------------------------------------------------------------- 戳一戳动作
  // 调度器仍是 executePokeAction。优先级 BACKGROUND < NORMAL < FORCE：
  // 低的不能打断高的，同级可以打断。accepted 只表示占上了槽；
  // start / end / interrupted 经 /ai/result 的 event 回给调用方。
  var pokeTimers = [];
  var actingTimer = 0;
  var legacyGen = 0;
  // 已经开播、关闭定时器还没跑的 closeMotion。
  // 抢占时按同一只手决定补不补播，判断来自 motion-director，不在这里写死左右手。
  var pendingCloses = [];

  // ------------------------------------------------------ 真实完成事件（PR-D）
  // 渲染包在 motion / keyframes 真实终点发事件（executionId = /ai/call 的 callId）。
  // overlay 按当前 act 关联：seen 达到 countRealCompletions 期望时提前 finishAct，
  // 结束回执带 completionSource:'runtime-event' + ownedParams（ownership 出口核对数据）。
  // 差额（Loop 动作 / 动作被拒 / 事件链路缺失）→ 永远等不齐 → 沿用 armActEnd 预估兜底，
  // fail-closed：预估从不冒充真实信号，只是迟到时的可用性兜底。
  var completionBound = false;
  var actCompletionState = { runId: 0, callId: null, expected: 0, seen: 0, owned: [] };

  function bindActCompletion(runId, callId, chain) {
    var L = window.DSH_L2D;
    var expected = L && L.countRealCompletions ? L.countRealCompletions(chain) : 0;
    actCompletionState = { runId: runId || 0, callId: callId == null ? null : callId, expected: expected, seen: 0, owned: [] };
  }

  function onRuntimeCompletion(ev) {
    var st = actCompletionState;
    if (!st || !st.runId || !st.expected) return;
    if (!ev || String(ev.executionId || '') !== String(st.callId)) return;
    if (!actStillCurrent(st.runId)) return; // 已被打断/超时收尾，预估路径已归位
    // PR-A 三态生命周期：interrupted / failed 不等期望数凑齐，立即终态收尾，
    // 不冒充 completed（end 才走 seen 计数路径）。
    if (ev && (ev.phase === 'interrupted' || ev.phase === 'failed')) {
      var apiT = window.DSH_L2D;
      var e2t = null;
      if (ev.phase === 'failed' && apiT && apiT.noteActMotion) {
        apiT.noteActMotion(st.runId, ev.reason || 'runtime-failed', 'fail');
        e2t = apiT.finishAct ? apiT.finishAct(st.runId) : null; // → phase:'failed'
      } else {
        e2t = apiT && apiT.releaseAct ? apiT.releaseAct(st.runId, ev.reason || ev.phase) : null; // → phase:'interrupted'
      }
      actCompletionState = { runId: 0, callId: null, expected: 0, seen: 0, owned: [] };
      if (!e2t) return; // 预估兜底先到：终态已发过，不重复
      e2t.completionSource = 'runtime-event';
      if (ev.owned) e2t.ownedParams = ev.owned.slice();
      postActEvent(e2t);
      if (actingTimer) {
        clearTimeout(actingTimer);
        actingTimer = 0;
      }
      if (apiT && apiT.setStageBusy) apiT.setStageBusy({ acting: false });
      return;
    }
    st.seen++;
    if (ev.owned) st.owned = ev.owned;
    if (st.seen < st.expected) return;
    var api = window.DSH_L2D;
    var e2 = api && api.finishAct ? api.finishAct(st.runId) : null; // runId 不匹配时幂等返回 null
    actCompletionState = { runId: 0, callId: null, expected: 0, seen: 0, owned: [] };
    if (!e2) return; // 预估兜底先到：end 已发过，不再重复
    e2.completionSource = 'runtime-event';
    e2.ownedParams = (st.owned || []).slice();
    postActEvent(e2);
    if (actingTimer) {
      clearTimeout(actingTimer);
      actingTimer = 0;
    }
    if (api && api.setStageBusy) api.setStageBusy({ acting: false });
  }

  function cancelActTimers() {
    for (var i = 0; i < pokeTimers.length; i++) clearTimeout(pokeTimers[i]);
    pokeTimers = [];
    if (actingTimer) {
      clearTimeout(actingTimer);
      actingTimer = 0;
    }
  }

  function postActEvent(event) {
    if (!event || !event.callId) return;
    fetch('/dsh-l2d/ai/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // token/epoch 随租约下发（flag 关时服务端忽略这两个字段）
      body: JSON.stringify({ id: event.callId, event: event, token: __aiLeaseToken, epoch: __aiLeaseEpoch }),
    }).catch(function () { /* 回执丢了，调用方会停在 pending */ });
  }

  function emitActEvents(events) {
    if (!events) return;
    for (var i = 0; i < events.length; i++) postActEvent(events[i]);
  }

  function plannedLifeMs(chain, holdMs) {
    var cursor = 0;
    var life = 400;
    for (var i = 0; i < chain.length; i++) {
      var step = chain[i] || {};
      cursor += Math.max(0, Number(step.delayMs) || 0);
      life = Math.max(life, cursor + 1800);
      if (step.closeMotion) {
        life = Math.max(life, cursor + (Number(step.closeAfterMs) || 6000) + 200);
      }
    }
    if (holdMs) life = Math.max(life, Number(holdMs) || 0);
    return life;
  }

  function resolveActChain(action, L) {
    var explicit = Array.isArray(action.chain) && action.chain.length > 0;
    var chain = explicit ? action.chain.slice() : [];
    if (!chain.length) {
      if (action.expression) chain.push({ kind: 'expression', name: action.expression });
      if (action.motion) chain.push({
        kind: 'motion',
        name: action.motion,
        closeMotion: action.closeMotion,
        closeAfterMs: action.closeAfterMs,
      });
      if (action.pose) chain.push({ kind: 'pose', pose: action.pose });
      if (action.look) chain.push({ kind: 'look', x: action.look.x, y: action.look.y });
    }
    var template = null;
    if (!chain.length && action.phase && L && L.actPhaseTemplate) {
      template = L.actPhaseTemplate(String(action.phase));
      if (template && template.chain && template.chain.length) chain = template.chain.slice();
      else template = null;
    }
    return { chain: chain, template: template };
  }

  function blockedAct(admission) {
    return {
      ok: false,
      accepted: false,
      reason: admission && admission.reason ? admission.reason : 'priority-blocked',
      priority: admission && admission.priority ? admission.priority : 'NORMAL',
      current: admission ? admission.current : null,
      runId: null,
      settled: false,
      outcome: 'rejected',
      events: [],
    };
  }

  function acceptedAct(admission, steps, plan) {
    var own = [];
    var evs = admission && admission.events ? admission.events : [];
    for (var i = 0; i < evs.length; i++) {
      if (evs[i] && evs[i].runId === admission.runId) own.push(evs[i]);
    }
    var out = {
      ok: true,
      accepted: true,
      settled: false,
      outcome: 'pending',
      runId: admission.runId,
      priority: admission.priority,
      steps: steps,
      source: admission.source || '',
      events: own,
    };
    // 计划层诊断：降级/超时这类事实只能在回执里自证，没有这两个字段就无法区分
    // 「计划没产出 notes」和「notes 没送到」，排查会一直靠猜。
    out.planSource = plan && plan.buckets && plan.buckets.length ? 'plan' : 'serial';
    if (plan && Array.isArray(plan.notes)) {
      out.planBuckets = plan.buckets ? plan.buckets.length : 0;
      out.planNotes = plan.notes.slice();
    }
    return out;
  }

  var SAFE_MOTION_PARAM = /^(?:Angle[XYZ]bs?|Position[XYZ]|LeanInput|ParamEyeBall[XY]|ParamEyeLOpen|ParamEyeROpen|ParamEyeSmile[LR]?|ParamMouthOpenY|ParamMouthForm|ParamCheek|ParamBreath|Movement[123])$/i;

  function pokeCapabilities() {
    var L = window.DSH_L2D;
    var cap = L && L.getCapabilities ? L.getCapabilities() : null;
    var expressions = ((cap && cap.expressions) || [])
      .map(function (item) { return item && item.name ? item.name : item; })
      .filter(function (name) { return typeof name === 'string' && name; });
    var motions = ((cap && cap.motionGroups) || [])
      .map(function (item) { return item && item.name ? item.name : item; })
      .filter(function (name) { return typeof name === 'string' && name && name !== 'Idle'; });
    var safeParams = ((cap && cap.params) || [])
      .map(function (item) { return item && item.id ? item.id : ''; })
      .filter(function (id) { return SAFE_MOTION_PARAM.test(id); })
      .slice(0, 48);
    return { expressions: expressions, motions: motions, safeParams: safeParams };
  }

  // ---------------------------------------------------------------- M1-d2 手势时间线接线

  /**
   * [M1-d2] 轨道时间上界（ms）：与 renderer playKeyframes 内部 kfDuration 同口径
   * （max(16, min(KF_MAX_MS=10000, duration || maxT))），供手势段 durationMs 映射。
   */
  function gestureTracksMaxT(tracks) {
    var maxT = 0;
    (Array.isArray(tracks) ? tracks : []).forEach(function (tr) {
      (Array.isArray(tr && tr.keys) ? tr.keys : []).forEach(function (k) {
        maxT = Math.max(maxT, Number(k && k[0]) || 0);
      });
    });
    return maxT;
  }

  /**
   * [M1-d2] l2d_play_keyframes 轨道 → GestureSegmentInput 映射（蓝图 §1.3 表）：
   * 段 id 'kf:'+param（确定性、可重放，天然去重同参数轨道）；group 'kf'（同批 keyframes
   * 同桶，整组超时/打断原子）；params 值只构成冲突域（同通道替换判定），不写模型。
   * durationMs <= 0（loop 长播）缺省 = 长期持有，到期清理不影响 kfTick 续期（R5）。
   */
  function gestureSegmentsFromTracks(tracks, durationMs) {
    var segs = [];
    (Array.isArray(tracks) ? tracks : []).forEach(function (tr) {
      if (!tr || typeof tr.param !== 'string' || !tr.param) return;
      var domain = {};
      domain[tr.param] = 0;
      var seg = { id: 'kf:' + tr.param, group: 'kf', params: domain };
      if (durationMs > 0) seg.durationMs = durationMs;
      segs.push(seg);
    });
    return segs;
  }

  /**
   * [M1-d2] 回执 arbitration 字段格式（l2d_act 与 l2d_play_keyframes 共用）。
   * 只增不改：既有消费者看不到该字段时行为不变（向后兼容增列，§6 回滚表）。
   */
  function arbReceipt(ga) {
    if (!ga) return undefined;
    return {
      entryId: ga.entryId,
      admitted: ga.admittedIds,
      rejected: ga.rejected,
      interrupted: ga.interrupted,
      releasedAgentParams: ga.releasedAgentParams,
      flagEnabled: ga.flagEnabled,
    };
  }

  /**
   * [M1-d2] 老包/flag 关直通判定：只有「明确拒绝且 flag 开」才短路（ga.admitted === false
   * 且 ga.flagEnabled === true）。renderer 缺 admitGesture（老包）或 flag 关
   * （flagEnabled:false）一律走原路径——新 overlay × 老 renderer 不误拒（§6 风险 1）。
   */
  function gestureBlocked(ga) {
    return !!(ga && ga.admitted === false && ga.flagEnabled === true);
  }

  function randomOf(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function actStillCurrent(runId) {
    var L = window.DSH_L2D;
    if (L && L.currentAct) {
      var cur = L.currentAct();
      return !!(cur && cur.runId === runId);
    }
    return legacyGen === runId;
  }

  function rememberClose(name) {
    if (!name) return;
    pendingCloses.push(name);
  }

  function dropPendingClose(name) {
    var next = [];
    var removed = false;
    for (var i = 0; i < pendingCloses.length; i++) {
      if (!removed && pendingCloses[i] === name) {
        removed = true;
        continue;
      }
      next.push(pendingCloses[i]);
    }
    pendingCloses = next;
  }

  function chainMotionPlan(chain) {
    var items = [];
    var elapsed = 0;
    for (var i = 0; i < (chain ? chain.length : 0); i++) {
      var step = chain[i] || {};
      elapsed += Math.max(0, Number(step.delayMs) || 0);
      if (step.kind === 'motion' && step.name) items.push({ name: step.name, at: elapsed });
    }
    return items;
  }

  function motionKind(result) {
    var L = window.DSH_L2D;
    if (L && L.motionResultKind) return L.motionResultKind(result);
    if (!result || result.status === 'ok') return 'ok';
    if (result.status === 'skipped' || result.reason === 'already-open' || result.reason === 'already-closed') return 'skip';
    return 'fail';
  }

  function waitMs(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * l2d_play_motion 的手臂让位：新旧动作共用手臂时，先按槽位播放对应「关闭」，
   * 再播新动作。不共用则直接播，不做全身重置、不清表情和体型。
   * 判定走渲染包 motionsShareArm / closesToPlayBefore（PR #4 状态机）。
   */
  function closesForIncomingMotion(L, group) {
    var slots = L && L.getMotionSlots ? L.getMotionSlots() : {};
    if (L && typeof L.closesToPlayBefore === 'function') {
      var planned = L.closesToPlayBefore(group, slots);
      return Array.isArray(planned) ? planned : [];
    }
    var share = L && typeof L.motionsShareArm === 'function'
      ? function (a, b) { return !!L.motionsShareArm(a, b); }
      : null;
    if (!share || !slots) return [];
    var closes = [];
    Object.keys(slots).forEach(function (base) {
      if (slots[base] !== 'open') return;
      if (group === base || group === base + '打开' || group === base + '关闭') return;
      if (share(base + '打开', group)) closes.push(base + '关闭');
    });
    return closes;
  }

  // 成对关闭动作约 1.0–1.25s；超过此时限就不再卡住 /ai/result，直接播新动作。
  var CLOSE_YIELD_TIMEOUT_MS = 2000;

  function raceTimeout(promise, ms, fallback) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(fallback);
      }, ms);
      Promise.resolve(promise).then(function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      });
    });
  }

  function playMotionYieldingSharedArm(L, group, opts) {
    var closes = closesForIncomingMotion(L, group);
    var playIncoming = function (interrupt) {
      var nextOpts = opts ? Object.assign({}, opts) : {};
      if (interrupt) nextOpts.interrupt = true;
      return L.playMotionAsync(group, nextOpts);
    };
    if (!closes.length) return playIncoming(false);
    var closeTimedOut = false;
    var seq = Promise.resolve();
    closes.forEach(function (name) {
      seq = seq.then(function () {
        return raceTimeout(
          L.playMotionAsync(name, { awaitFinish: true, interrupt: true }),
          CLOSE_YIELD_TIMEOUT_MS,
          { status: 'timeout', timedOut: true, group: name }
        ).then(function (r) {
          if (r && r.timedOut) closeTimedOut = true;
          return r;
        });
      });
    });
    // 收尾后（或收尾超时后）用 interrupt 播新动作，避免关闭仍在播时被 start-rejected。
    return seq.then(function () { return playIncoming(true); }).then(function (result) {
      if (result && typeof result === 'object') {
        result.yieldedCloses = closes;
        if (closeTimedOut) result.closeYieldTimedOut = true;
      }
      return result;
    });
  }

  function closesToFlush(chain) {
    var L = window.DSH_L2D;
    var shares = L && typeof L.motionsShareArm === 'function'
      ? function (closeName, motionName) { return !!L.motionsShareArm(closeName, motionName); }
      : undefined;
    if (L && L.closeMotionsOnPreempt) return L.closeMotionsOnPreempt(pendingCloses, chain, shares);
    return [];
  }

  // ownMotion 才记回执、才可能弹气泡。补播的关闭动作不弹。
  // 气泡和 reason 只留给真正失败（被拒、被吞）。already-open 这类跳过放 notes。
  function watchMotion(runId, pending, source, ownMotion) {
    Promise.resolve(pending).then(function (result) {
      if (!ownMotion) return;
      var kind = motionKind(result);
      if (kind === 'ok') return;
      var text = (result && (result.reason || result.status)) || 'motion-rejected';
      var L = window.DSH_L2D;
      if (L && L.noteActMotion && runId) L.noteActMotion(runId, String(text), kind === 'skip' ? 'skip' : 'fail');
      if (source === 'poke' && kind === 'fail') say('这个动作先让位', 2200);
    }).catch(function (err) {
      if (!ownMotion) return;
      var reason = err && err.message ? err.message : 'motion-failed';
      var L = window.DSH_L2D;
      if (L && L.noteActMotion && runId) L.noteActMotion(runId, String(reason), 'fail');
      if (source === 'poke') say('这个动作先让位', 2200);
    });
  }

  // 新动作按自己的 delayMs 排。后面还有关闭或其他动作时，等 playMotionAsync 返回再播下一个。
  function playSerial(motions, closes, runId, source) {
    var L = window.DSH_L2D;
    var seq = Promise.resolve();
    var prevAt = 0;
    for (var i = 0; i < motions.length; i++) {
      (function (item, index, gap) {
        var awaitFinish = index < motions.length - 1 || closes.length > 0;
        seq = seq.then(function () {
          return waitMs(gap).then(function () {
            if (runId && !actStillCurrent(runId)) return null;
            if (!L || !L.playMotionAsync) return null;
            var pending = L.playMotionAsync(item.name, { awaitFinish: awaitFinish });
            watchMotion(runId, pending, source, true);
            return pending;
          });
        });
      })(motions[i], i, motions[i].at - prevAt);
      prevAt = motions[i].at;
    }
    for (var j = 0; j < closes.length; j++) {
      (function (name, awaitFinish) {
        seq = seq.then(function () {
          if (runId && !actStillCurrent(runId)) return null;
          if (!L || !L.playMotionAsync) return null;
          var pending = L.playMotionAsync(name, { awaitFinish: awaitFinish });
          watchMotion(runId, pending, source, false);
          return pending;
        });
      })(closes[j], j < closes.length - 1);
    }
    return seq;
  }

  function preemptYandereIfNeeded(admission) {
    var L = window.DSH_L2D;
    var stolen = false;
    if (L && L.preemptedYandere) {
      stolen = L.preemptedYandere(admission && admission.current, { on: yandereOn, runId: yandereActRunId });
    } else if (yandereOn && admission && admission.current) {
      stolen = admission.current.source === 'yandere' || (!!yandereActRunId && admission.current.runId === yandereActRunId);
    }
    if (!stolen) return;
    // 常驻模式：只标记开场被打断。暗角和黑脸留着，关闭动作留给 closesToFlush。
    yandereActRunId = 0;
  }

  function scheduleCloseMotion(closeMotion, delayMs, runId) {
    var L = window.DSH_L2D;
    if (!L || !closeMotion || !L.playMotionAsync) return;
    rememberClose(closeMotion);
    pokeTimers.push(setTimeout(function () {
      dropPendingClose(closeMotion);
      if (!actStillCurrent(runId)) return;
      L.playMotionAsync(closeMotion).catch(function () { /* 状态机可能已处理 */ });
    }, delayMs || 6000));
  }

  function runActStep(step, runId, source, skipMotions, executionId) {
    var L = window.DSH_L2D;
    if (!L || !step || !actStillCurrent(runId)) return;
    if (step.kind === 'expression') {
      if (step.clear && L.clearExpression) L.clearExpression();
      else if (step.name && L.setExpression) L.setExpression(step.name);
    } else if (step.kind === 'motion' && step.name) {
      if (!skipMotions && L.playMotionAsync) {
        watchMotion(runId, L.playMotionAsync(step.name, {
          executionId: executionId == null ? undefined : executionId,
        }), source, true);
      }
      if (step.closeMotion) {
        scheduleCloseMotion(step.closeMotion, step.closeAfterMs || 6000, runId);
      }
    } else if (step.kind === 'keyframes' && L.playKeyframes) {
      // [M1-d2] 链已过 admitAct（P1），此处只做 Timeline 记账：登记段让 kfTick 到期记账
      // 生效、后续手势能按参数域与链内 keyframes 冲突。被拒 → 记 notes（skip），不当失败，
      // 链其余步骤照常（R4）。
      if (L.admitGesture) {
        var kCur = L.currentAct ? L.currentAct() : null;
        var kChainPri = kCur && kCur.runId === runId && (kCur.priority === 10 || kCur.priority === 50 || kCur.priority === 90)
          ? kCur.priority
          : undefined;
        var kDur = step.loop === true
          ? 0
          : Math.max(16, Math.min(10000, Number(step.duration) || gestureTracksMaxT(step.tracks)));
        var kSegs = gestureSegmentsFromTracks(step.tracks, kDur).map(function (seg) {
          if (kChainPri !== undefined) seg.priority = kChainPri;
          return seg;
        });
        var kga = L.admitGesture(kSegs, { entryId: 'act:' + runId });
        if (gestureBlocked(kga)) {
          if (L.noteActMotion) {
            var kReason = kga.rejected && kga.rejected[0] && kga.rejected[0].reason ? kga.rejected[0].reason : 'unknown';
            L.noteActMotion(runId, 'gesture-blocked:' + kReason, 'skip');
          }
          return;
        }
      }
      L.playKeyframes(step.tracks || [], {
        duration: step.duration,
        loop: step.loop === true,
        executionId: executionId == null ? undefined : executionId,
      });
    } else if (step.kind === 'pose' && step.pose && L.setPose) {
      L.setPose(step.pose);
    } else if (step.kind === 'look' && L.lookAt) {
      L.lookAt(step.x || 0, step.y || 0);
    }
  }

  // 整组超时：到点取消整组，结束回执 phase='end' + reason:'timeout'。
  // [README 契约修正] 超时是计划内终态（accept-D 断言 end.reason='timeout'），
  // 不是执行失败——旧实现 noteActMotion('timeout','fail') 会把终态判成
  // 'failed'，与「failed=链内动作真实失败（start-rejected 等）」的三态语义冲突。
  function timeoutActGroup(runId) {
    var L = window.DSH_L2D;
    if (!L || !actStillCurrent(runId)) return;
    if (L.noteActMotion) L.noteActMotion(runId, 'timeout', 'skip');
    cancelActTimers();
    var ev = L.finishAct
      ? L.finishAct(runId, 'timeout') // 新渲染包：end + reason='timeout'
      : null;
    if (ev) postActEvent(ev);
    if (L.setStageBusy) L.setStageBusy({ acting: false });
  }

  // 按执行计划投放：桶内每步按自己的 atMs 投放（降级成串行后 atMs 已被拉开），
  // 不能整桶同一 tick 连发——那样降级只是改了记账，观感上仍是并行。
  // 计划由渲染包的 normalizeActPlan 生成（core/src/chain-normalize.ts），老包没有时退回串行。
  function playActPlan(plan, runId, source, skipMotions, executionId) {
    var buckets = (plan && plan.buckets) || [];
    for (var b = 0; b < buckets.length; b++) {
      (function (bucket) {
        for (var i = 0; i < bucket.steps.length; i++) {
          (function (node) {
            var at = Math.max(0, Number(node.atMs) || 0);
            if (at <= 0) {
              runActStep(node.step, runId, source, skipMotions, executionId);
            } else {
              pokeTimers.push(setTimeout(function () {
                runActStep(node.step, runId, source, skipMotions, executionId);
              }, at));
            }
          })(bucket.steps[i]);
        }
        if (bucket.timeoutMs > 0) {
          pokeTimers.push(setTimeout(function () {
            timeoutActGroup(runId);
          }, bucket.atMs + bucket.timeoutMs));
        }
      })(buckets[b]);
    }
  }

  function playActSteps(chain, runId, source, skipMotions, plan, executionId) {
    var L = window.DSH_L2D;
    // 计划由调用方一次算好并传进来（同一份对象既算寿命又记 notes），
    // 老调用方没传时才就地补算，保证「寿命」与「降级事实」永远来自同一份计划。
    var usePlan = plan || null;
    if (!usePlan && L && L.normalizeActPlan) {
      try {
        usePlan = L.normalizeActPlan(chain);
      } catch (err) {
        usePlan = null;
      }
    }
    if (usePlan && usePlan.buckets && usePlan.buckets.length) {
      // 降级/超时这类「计划层」信息进 notes（kind=skip 不算失败），回执里能看见
      if (usePlan.notes && L.noteActMotion) {
        for (var n = 0; n < usePlan.notes.length; n++) L.noteActMotion(runId, usePlan.notes[n], 'skip');
      }
      playActPlan(usePlan, runId, source, skipMotions, executionId);
      return;
    }
    var elapsed = 0;
    for (var i = 0; i < chain.length; i++) {
      var step = chain[i];
      var delay = Math.max(0, Number(step.delayMs) || 0);
      elapsed += delay;
      if (elapsed <= 0) {
        runActStep(step, runId, source, skipMotions, executionId);
      } else {
        (function (pending, at) {
          pokeTimers.push(setTimeout(function () {
            runActStep(pending, runId, source, skipMotions, executionId);
          }, at));
        })(step, elapsed);
      }
    }
  }

  function armActEnd(runId, life) {
    var L = window.DSH_L2D;
    if (L && L.setStageBusy) L.setStageBusy({ acting: true });
    actingTimer = setTimeout(function () {
      actingTimer = 0;
      var api = window.DSH_L2D;
      if (api && api.finishAct) {
        var ev = api.finishAct(runId);
        if (ev) postActEvent(ev);
      } else if (legacyGen === runId) {
        legacyGen = 0;
      }
      if (api && api.setStageBusy) api.setStageBusy({ acting: false });
    }, life);
  }

  function releaseActRun(runId, reason) {
    var L = window.DSH_L2D;
    if (!L || !L.releaseAct || !runId) return null;
    var ev = L.releaseAct(runId, reason || 'released');
    if (!ev) return null;
    pendingCloses = [];
    cancelActTimers();
    postActEvent(ev);
    if (L.setStageBusy) L.setStageBusy({ acting: false });
    return ev;
  }

  function playbackAct(chain, runId, source, holdOnly, plan, executionId) {
    var flush = closesToFlush(chain);
    var motions = chainMotionPlan(chain);
    pendingCloses = [];
    cancelActTimers();
    if (holdOnly) return;
    // 另一只手的关闭不能和新动作同时发，否则状态机把后一个吞掉。先播新动作，等它返回再收。
    if (flush.length && motions.length) {
      playSerial(motions, flush, runId, source);
      playActSteps(chain, runId, source, true, plan, executionId);
      return;
    }
    if (flush.length) playSerial([], flush, runId, source);
    playActSteps(chain, runId, source, false, plan, executionId);
  }

  function executePokeAction(action) {
    var L = window.DSH_L2D;
    if (!L || !action) return { ok: false, accepted: false, reason: 'renderer-not-ready' };
    var built = resolveActChain(action, L);
    var chain = built.chain;
    if (!chain.length && !action.holdOnly) {
      return { ok: false, accepted: false, reason: 'empty-chain', settled: false, outcome: 'rejected', events: [] };
    }

    var priority = action.priority;
    if ((priority === undefined || priority === null || priority === '') && built.template) {
      priority = built.template.priority;
    }
    var source = action.source || (built.template ? built.template.id : 'act');
    // 寿命单一来源：计划里有 lifeMs 就用计划的（它把同桶重叠、整组超时都算进去了）；
    // 只有在老包没有 normalizeActPlan 时才退回本地估算，避免两套算法分叉，
    // 出现「计划还没走完，armActEnd 先把槽放掉」。
    var planForLife = null;
    if (L.normalizeActPlan) {
      try {
        planForLife = L.normalizeActPlan(chain);
      } catch (err) {
        planForLife = null;
      }
    }
    var life = planForLife && planForLife.lifeMs > 0 ? planForLife.lifeMs : plannedLifeMs(chain, action.holdMs);

    if (!L.admitAct || !L.currentAct || !L.finishAct) {
      legacyGen += 1;
      var legacyId = legacyGen;
      playbackAct(chain, legacyId, source, !!action.holdOnly);
      armActEnd(legacyId, life);
      if (action.bubble) say(action.bubble, 3200);
      else if (!action.silent) say('戳戳~', 2200);
      return {
        ok: true,
        accepted: true,
        settled: false,
        outcome: 'pending',
        reason: 'no-gate',
        runId: legacyId,
        priority: 'NORMAL',
        steps: chain.length,
        events: [],
      };
    }

    var admission = L.admitAct({
      priority: priority,
      callId: action.callId || null,
      source: source,
      steps: chain.length,
    });
    if (!admission || !admission.accepted) return blockedAct(admission);
    preemptYandereIfNeeded(admission);
    // PR-D：真实完成事件关联（executionId = callId）。老渲染包没有订阅口时 expected=0，
    // 完成回执仍走 armActEnd 预估兜底。
    if (!completionBound && L.onActionCompletion) {
      completionBound = true;
      L.onActionCompletion(onRuntimeCompletion);
    }
    bindActCompletion(admission.runId, action.callId, chain);
    playbackAct(chain, admission.runId, source, !!action.holdOnly, planForLife, action.callId);
    emitActEvents(admission.events);
    // 先挂上结束回执，避免步骤里抛错后槽位一直占着。
    // PR-D：真实完成先到时 finishAct 幂等（runId 不匹配返回 null），本定时器成空转。
    armActEnd(admission.runId, life);
    if (action.bubble) say(action.bubble, 3200);
    else if (!action.silent) say('戳戳~', 2200);
    return acceptedAct(admission, action.holdOnly ? 0 : chain.length, planForLife);
  }

  function pokeRandom() {
    var L = window.DSH_L2D;
    if (!L || !L.isReady || !L.isReady()) {
      say('模型还没准备好', 1800);
      return;
    }
    var cap = pokeCapabilities();
    var expressions = cap.expressions;
    var motions = cap.motions.filter(function (name) { return name.endsWith('打开'); });
    if (dbActionRaw.length && !dbActionPoolBuilt) buildDbPool();
    var roll = Math.random();

    try {
      // 概率分段：表情 0-0.36 / 动作 0.36-0.76 / DB 动作链 0.76-0.92 / 姿势兑底
      if (roll < 0.36 && expressions.length) {
        var expression = randomOf(expressions);
        executePokeAction({
          priority: 'FORCE',
          source: 'poke',
          bubble: expression,
          chain: [
            { kind: 'expression', name: expression },
            { kind: 'look', x: (Math.random() - 0.5) * 0.7, y: Math.random() * 0.35 },
          ],
        });
        return;
      }

      if (roll < 0.76 && motions.length) {
        var motion = randomOf(motions);
        executePokeAction({
          priority: 'FORCE',
          source: 'poke',
          bubble: '看这个~',
          chain: [{
            kind: 'motion',
            name: motion,
            closeMotion: motion.replace(/打开$/, '关闭'),
            closeAfterMs: 5200 + Math.random() * 2600,
          }],
        });
        return;
      }

      if (roll < 0.92 && dbActionPool.length) {
        // UI-FLOAT ⑤：SQLite 动作链入池，经 executePokeAction 走统一状态机
        var dbItem = randomOf(dbActionPool);
        executePokeAction({
          priority: 'FORCE',
          source: 'poke-db',
          callId: dbItem.chainId,
          bubble: '看这个~',
          chain: dbItem.chain,
        });
        return;
      }

      var poses = ['finger', 'grass', 'chest'];
      var poseName = randomOf(poses);
      var pose = poseName === 'chest'
        ? { right: 'rest', left: 'chest' }
        : { right: poseName, left: 'rest' };
      executePokeAction({
        priority: 'FORCE',
        source: 'poke',
        bubble: poseName === 'finger' ? '看这里！' : poseName === 'grass' ? '给你草草' : '抱抱~',
        chain: [{ kind: 'pose', pose: pose }],
      });
    } catch (err) {
      console.warn('[dsh-l2d] random poke failed', err);
      say('今天不太想动…', 2200);
    }
  }

  // ------------------------------------------------ 动作池读库接线（UI-FLOAT ⑤）
  // 启动时经 GET /api/actions 拉取动作链（validated+compatible 由服务端过滤），
  // 失败静默降级（现有随机池照常）。链展开与参数白名单防线保持在此（写路径上游），
  // executePokeAction 的状态机语义不动。
  var dbActionRaw = [];     // /api/actions 原始行
  var dbActionPool = [];    // 展开并校验后的可执行链
  var dbActionPoolBuilt = false;
  var dbAllowedParams = {}; // 从 DB adapter 动态放行的 ParamId（不硬编码）

  function dbParamAllowed(id) {
    return SAFE_MOTION_PARAM.test(id) || dbAllowedParams[id] === true;
  }

  function parseMaybeJson(v) {
    if (v && typeof v === 'object') return v;
    if (typeof v !== 'string' || !v) return null;
    try { return JSON.parse(v); } catch (err) { return null; }
  }

  function dbChannelKeys(name) {
    // chainJson 的 track 名是 camelCase（earLeft），adapter channels 是 snake_case（ear_left）
    var k = String(name || '');
    return [k, k.replace(/([A-Z])/g, '_$1').toLowerCase()];
  }

  function expandDbChain(rawChain, adapter, capIds) {
    var steps = rawChain && Array.isArray(rawChain.steps) ? rawChain.steps : [];
    var channels = (adapter && adapter.channels) || {};
    var out = [];
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      if (!step || !step.kind) continue;
      if (step.kind === 'expression') {
        var name = step.name || step.expression;
        if (name) out.push({ kind: 'expression', name: String(name) });
        continue;
      }
      if (step.kind !== 'keyframes') continue;
      var params = step.params || step.track || null;
      if (!params || !params.track || !Array.isArray(params.keys)) continue;
      var keys0 = dbChannelKeys(params.track);
      var mapped = [];
      for (var c = 0; c < keys0.length && !mapped.length; c++) mapped = channels[keys0[c]] || [];
      var sw = Number(step.weight == null ? 1 : step.weight) || 1;
      var tracks = [];
      for (var j = 0; j < mapped.length; j++) {
        var ch = mapped[j];
        if (!ch || !ch.paramId) continue;
        // 防线（写路径上游）：白名单（SAFE_MOTION_PARAM ∪ DB adapter 动态登记）+ 模型实有参数
        if (!dbParamAllowed(ch.paramId)) continue;
        if (capIds && !capIds[ch.paramId]) continue;
        var cw = Number(ch.weight == null ? 1 : ch.weight) || 1;
        var w = sw * cw;
        var keys = [];
        for (var k = 0; k < params.keys.length; k++) {
          var p = params.keys[k];
          keys.push([Number(p.t) || 0, (Number(p.value) || 0) * w]);
        }
        tracks.push({ param: String(ch.paramId), keys: keys });
      }
      if (!tracks.length) continue;
      out.push({ kind: 'keyframes', duration: Number(step.durationMs) || undefined, tracks: tracks });
    }
    return out;
  }

  function buildDbPool() {
    var L = window.DSH_L2D;
    var cap = L && L.getCapabilities ? L.getCapabilities() : null;
    var capParams = (cap && cap.params) || [];
    if (!capParams.length) {
      // 能力清单未就绪：不锁空池，等下次触发（pokeRandom/dbActions）再建
      dbActionPoolBuilt = false;
      return;
    }
    var capIds = {};
    for (var i = 0; i < capParams.length; i++) {
      if (capParams[i] && capParams[i].id) capIds[capParams[i].id] = true;
    }
    // 第一遍：收集所有 adapter 登记的 paramId，动态扩白名单
    for (var r = 0; r < dbActionRaw.length; r++) {
      var adapter0 = parseMaybeJson(dbActionRaw[r] && dbActionRaw[r].adapterJson);
      var chans = (adapter0 && adapter0.channels) || {};
      var ks = Object.keys(chans);
      for (var m = 0; m < ks.length; m++) {
        var entries = chans[ks[m]] || [];
        for (var n = 0; n < entries.length; n++) {
          if (entries[n] && entries[n].paramId) dbAllowedParams[String(entries[n].paramId)] = true;
        }
      }
    }
    // 第二遍：展开 + 校验
    var pool = [];
    for (var a = 0; a < dbActionRaw.length; a++) {
      var rowA = dbActionRaw[a];
      try {
        var raw = parseMaybeJson(rowA && rowA.chainJson);
        var adapter = parseMaybeJson(rowA && rowA.adapterJson);
        var chain = expandDbChain(raw, adapter, capIds);
        if (chain.length) {
          pool.push({
            chainId: String(rowA.chainId || rowA.semanticKey || ('db-' + a)),
            semanticKey: String(rowA.semanticKey || ''),
            emotion: String(rowA.emotion || ''),
            chain: chain,
          });
        }
      } catch (err) { /* 单链解析失败不影响其它 */ }
    }
    dbActionPool = pool;
    dbActionPoolBuilt = true;
  }

  function loadDbActions() {
    fetch('/api/actions', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || data.ok !== true || !Array.isArray(data.actions)) return;
        dbActionRaw = data.actions;
        dbActionPoolBuilt = false;
        if (window.DSH_L2D && window.DSH_L2D.isReady && window.DSH_L2D.isReady()) buildDbPool();
      })
      .catch(function () { /* 静默降级：现有随机池照常 */ });
  }

  function pokeByApi(silent) {
    var L = window.DSH_L2D;
    if (!L || !L.isReady || !L.isReady()) {
      if (!silent) say('模型还没准备好', 1800);
      return;
    }
    var cap = pokeCapabilities();
    if (!cap.expressions.length || !cap.motions.length) return pokeRandom();

    if (!silent) say('让 DeepSeek 想想…', 2600);
    fetch('/dsh-l2d/ai-action.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expressions: cap.expressions,
        motions: cap.motions,
        safeParams: cap.safeParams,
      }),
      cache: 'no-store',
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) throw new Error('http');
        if (!data.ok) {
          if (data.reason === 'no-key') {
            if (!silent) say('没配 Key，我先随机一个', 2600);
            return pokeRandom();
          }
          if (data.reason === 'cooldown') {
            if (!silent) say('刚刚戳过了，等等我', 2200);
            return;
          }
          throw new Error(data.reason || 'api');
        }
        data.priority = 'FORCE';
        data.source = 'poke';
        executePokeAction(data);
      })
      .catch(function (err) {
        console.warn('[dsh-l2d] api poke failed', err);
        if (!silent) say('API 不太配合，我先随机一个', 2600);
        pokeRandom();
      });
  }

  function pokeAction() {
    if (settings.clickMode === 'nodegraph') return pokeByNodegraph();
    if (settings.clickMode === 'api') return pokeByApi();
    return pokeRandom();
  }

  // ---------------------------------------------------------------- 节点图编排戳一戳
  // 固定命名节点图 poke-response（模型导入时由语义模板自动生成，strict 绑定当前模型）。
  // 服务端 run 通道经 aiInbox l2d_act 下发（与 /ai/call 同一执行链路），回执 receipts
  // 在 /dsh-l2d/nodegraphs/executions?id=X 可回查。失败 fail-open 降级随机动作：
  // 节点图只是编排偏好，绝不能让戳一戳哑掉（mode-blocked / model-mismatch / busy /
  // 图不存在 / 网络异常一律降级）。
  var POKE_NODEGRAPH_NAME = 'poke-response';

  function pokeByNodegraph() {
    var L = window.DSH_L2D;
    if (!L || !L.isReady || !L.isReady()) {
      say('模型还没准备好', 1800);
      return;
    }
    fetch('/dsh-l2d/nodegraphs/run?name=' + encodeURIComponent(POKE_NODEGRAPH_NAME), {
      method: 'POST',
      cache: 'no-store',
    })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (data) {
        if (data && data.ok === true && data.status === 'completed') {
          say('戳戳~', 2200);
          return;
        }
        console.warn('[dsh-l2d] nodegraph poke fallback', data && (data.reason || data.errors || data.status));
        say('节点图不配合，先随机一个', 2200);
        pokeRandom();
      })
      .catch(function (err) {
        console.warn('[dsh-l2d] nodegraph poke failed', err);
        pokeRandom();
      });
  }

  // ---------------------------------------------------------------- 交互
  function bindClick() {
    // 单击身体：分区互动；右键：选项卡菜单；拖动后的 click 不算戳一戳。
    var downX = 0;
    var downY = 0;
    window.addEventListener('pointerdown', function (e) {
      if (isL2dUiTarget(e.target)) return;
      downX = e.clientX;
      downY = e.clientY;
    });
    window.addEventListener('click', function (e) {
      if (isL2dUiTarget(e.target)) return;
      // 拖动后的那次 click 视为移动手势，不下传页面（否则拖完松手会误触下层元素）
      if (Date.now() - lastDragMovedAt < 150) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) return;
      if (Date.now() - Number(window.__DSH_L2D_SKIRT_DRAGGED__ || 0) < 120) return;
      if (!overModel(e)) return; // 空白处：放行给下层页面
      e.stopPropagation();
      e.preventDefault();
      handleZoneClick(e);
    }, true);

    window.addEventListener('contextmenu', function (e) {
      if (isL2dUiTarget(e.target)) return;
      if (!overModelRightClick(e)) return; // 空白处：保留下层默认行为
      e.preventDefault();
      e.stopPropagation();
      menuView = 'root'; // 右键始终回到根菜单
      openMenuAt(e);
    }, true);

    document.addEventListener('click', function (e) {
      if (!menuEl || !menuEl.classList.contains('open')) return;
      if (menuEl.contains(e.target) || bodyEl.contains(e.target)) return;
      closeMenu();
    });
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);

    // 悬停 350ms 更新底部价格条；不再抢对话框。
    var hoverTimer = null;
    bodyEl.addEventListener('mouseenter', function () {
      if (settings.petMode === true) return; // 桌宠模式：悬停零触发（余额条也不弹）
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        hoverTimer = null;
        showBalance();
      }, 350);
    });
    bodyEl.addEventListener('mouseleave', function () {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    });

    // 底部小徽标保留状态切换。
    chipEl.addEventListener('click', function (e) {
      e.stopPropagation();
      cycleState();
    });
  }

  function cycleState() {
    var i = STATES.indexOf(prefs.state);
    setState(STATES[(i + 1) % STATES.length]);
  }

  // ---------------------------------------------------------------- Live2D 渲染
  // 单图片只是兜底。正常路径是：加载 Cubism Core → 加载渲染包 → 挂载模型。
  var canvasEl = null;
  var rendererReady = false;
  var rendererFailed = false;

  // ---------------------------------------------------------------- P0 修复：故障恢复状态机
  // 规格源：lib/l2d-recovery.mjs（纯函数模块，node 测试直接驱动）。overlay 是
  // classic script 无法 import，这里内嵌同语义实现；l2d-recovery.test.mjs 同时
  // 对本段做静态钩子断言，防止内嵌实现被后续重构悄悄删除。
  // 核心原则：模型是可选组件，DSH 是核心宿主——模型失败 ≠ 插件失败 ≠ DSH 失败。
  var L2D_RECOVERY = {
    state: 'initializing',
    attempts: 0,          // 本轮已自动重试次数
    maxRetries: 3,        // 每轮自动重试上限（用户验收参数）
    retryTimers: [1000, 3000, 8000], // 重试间隔 1s/3s/8s
    loadTimeoutMs: 15000, // 单次加载超时
    timer: null,
    generation: 0,        // 加载代数：旧代异步完成不得覆盖新代状态
    lastError: null,
    modelDisabled: false, // 用户裁决：禁用当前模型（模组其余功能可用）
    moduleDisabled: false // 用户裁决：禁用整个模组（localStorage 持久化）
  };

  function setL2DState(state, error) {
    L2D_RECOVERY.state = state;
    if (error) L2D_RECOVERY.lastError = error;
    if (root) {
      try { root.dataset.l2dState = state; } catch (err) { /* ignore */ }
      // failed 态收缩为 48×48 迷你徽标（页内只留这个可点击入口，
      // 完整报错处理在画中画窗口里；48 是用户「桌宠不压页面」裁决的落地）。
      try {
        if (state === 'failed') {
          root.style.width = '48px';
          root.style.height = '48px';
        }
      } catch (err) { /* ignore */ }
    }
    try {
      window.dispatchEvent(new CustomEvent('dsh:l2d:state', {
        detail: { state: state, error: L2D_RECOVERY.lastError, attempts: L2D_RECOVERY.attempts }
      }));
    } catch (err) { /* ignore */ }
  }

  /** 失败/加载中收缩容器：隐藏渲染层与静态图，释放交互区域（透明 canvas 不再挡 DSH 按钮）。 */
  function collapseL2DContainer() {
    if (!root) return;
    root.style.width = '300px';
    root.style.height = '300px';
    if (canvasEl) canvasEl.style.display = 'none';
    if (imgEl) imgEl.style.display = 'none';
  }

  /** 模型就绪：恢复宿主缩放对应的容器尺寸，显示画布。 */
  function restoreL2DContainer() {
    if (!root) return;
    root.style.width = '';
    root.style.height = '';
    if (canvasEl) canvasEl.style.display = 'block';
  }

  function clearL2DRetryTimer() {
    if (L2D_RECOVERY.timer != null) {
      clearTimeout(L2D_RECOVERY.timer);
      L2D_RECOVERY.timer = null;
    }
  }

  /**
   * 自动重试调度：1s/3s/8s ×3，耗尽后停止自动重试（等待用户操作）并弹错误对话框。
   * @param gen 本轮加载代数；不匹配说明已有新代接管，本轮失败作废（防旧代竞态覆盖）。
   */
  function scheduleL2DRetry(gen, error) {
    if (gen !== L2D_RECOVERY.generation) return; // stale generation：忽略
    if (L2D_RECOVERY.moduleDisabled || L2D_RECOVERY.modelDisabled) return;
    L2D_RECOVERY.lastError = error || L2D_RECOVERY.lastError;

    if (L2D_RECOVERY.attempts >= L2D_RECOVERY.maxRetries) {
      rendererFailed = true;
      fallbackToImage(L2D_RECOVERY.lastError); // 300×300 内保留静态立绘兜底
      setL2DState('failed');
      openL2DErrorUi(L2D_RECOVERY.lastError); // PiP 优先，无 activation 降级页内小卡片
      return;
    }

    var delay = L2D_RECOVERY.retryTimers[Math.min(L2D_RECOVERY.attempts, L2D_RECOVERY.retryTimers.length - 1)];
    L2D_RECOVERY.attempts += 1;
    setL2DState('retry_wait');
    clearL2DRetryTimer();
    L2D_RECOVERY.timer = setTimeout(function () {
      L2D_RECOVERY.timer = null;
      retryL2DRenderer(false);
    }, delay);
  }

  /**
   * 重试一轮加载。manual=true（用户点对话框）时计数清零，不限次数。
   * 重试前销毁旧渲染实例并移除旧 <script>，防止重复 Canvas / 双 RAF / 双实例。
   */
  function retryL2DRenderer(manual) {
    if (L2D_RECOVERY.moduleDisabled) return;
    if (manual) {
      L2D_RECOVERY.attempts = 0;
      L2D_RECOVERY.modelDisabled = false;
    } else if (L2D_RECOVERY.modelDisabled) {
      return;
    }
    clearL2DRetryTimer();
    // 旧实例销毁（WebGL/纹理/事件监听由渲染包 destroy 统一释放）
    var L = window.DSH_L2D;
    if (L && L.destroy) { try { L.destroy(); } catch (err) { /* ignore */ } }
    // 旧渲染包 <script> 移除：loadScriptOnce 见到同 id 会短路，拿到的是旧 bundle
    try {
      var stale = document.getElementById('dsh-l2d-renderer');
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    } catch (err) { /* ignore */ }
    rendererReady = false;
    rendererFailed = false;
    if (canvasEl) { canvasEl.style.display = ''; canvasEl.classList.remove('dragging'); }
    if (imgEl) { imgEl.style.display = 'none'; imgEl.removeAttribute('src'); }
    collapseL2DContainer();
    initRenderer();
  }

  // ---- P0-PiP：错误处理入口（浏览器画中画优先） ----
  // 统一入口 openL2DErrorUi：
  //   1. Document PiP 可用（Chromium 116+）→ 独立小窗承载完整四出口对话框；
  //   2. 不可用/被拒（如自动弹出时无 transient user activation）→ 页内右下角小卡片降级。
  // 自动弹出（重试耗尽）通常没有 user activation，PiP 会拒绝——此时页面里只留
  // 48×48 徽标 + 右下角小卡片；用户点徽标（user gesture）必能开 PiP 窗口。
  var ERROR_ACTIONS = [
    { action: 'retry', label: '重新加载 Plugin（重置重试计数）' },
    { action: 'model', label: '禁用当前模型（保留 DSH 其余功能）' },
    { action: 'module', label: '禁用整个 DSH-Live2D 模组（刷新后仍生效）' },
    { action: 'refresh', label: '刷新页面并重新初始化' }
  ];

  /** 四出口共用裁决（页内卡片与 PiP 窗口共用）；close() 负责关闭各自的宿主 UI。 */
  function handleL2DErrorAction(action, close) {
    if (action === 'retry') {
      close();
      retryL2DRenderer(true);
    } else if (action === 'model') {
      L2D_RECOVERY.modelDisabled = true;
      clearL2DRetryTimer();
      collapseL2DContainer();
      setL2DState('model_disabled');
      close();
    } else if (action === 'module') {
      L2D_RECOVERY.moduleDisabled = true;
      clearL2DRetryTimer();
      try { localStorage.setItem('dsh-l2d.disabled', 'true'); } catch (err) { /* ignore */ }
      try { window.dispatchEvent(new CustomEvent('dsh:l2d:disable-module')); } catch (err) { /* ignore */ }
      if (root && root.parentNode) root.parentNode.removeChild(root);
      close();
    } else if (action === 'refresh') {
      // 前端刷新：bootOverlay 重新注入 → 检查禁用标志 → 重新走完整初始化链
      location.reload();
    }
  }

  /** 构建错误卡片（doc 参数：主 document 或 PiP document）；纯 createElement/textContent 防注入。 */
  function buildL2DErrorCard(doc, error) {
    var card = doc.createElement('div');
    card.className = 'l2d-error-card';

    var title = doc.createElement('div');
    title.className = 'l2d-error-title';
    title.textContent = 'Live2D 模型加载失败';
    card.appendChild(title);

    var message = doc.createElement('div');
    message.className = 'l2d-error-message';
    message.textContent = String(error || '未知错误') + '（已自动重试 3 次，模型为可选组件，DSH 其余功能不受影响）';
    card.appendChild(message);

    ERROR_ACTIONS.forEach(function (item) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.dataset.action = item.action;
      btn.textContent = item.label;
      card.appendChild(btn);
    });
    return card;
  }

  function removeInlineErrorDialog() {
    var old = document.getElementById('dsh-l2d-error-dialog');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  /**
   * 页内降级：右下角小卡片（无全屏遮罩，页面可继续操作）。
   * 独立挂 document.body（不在角色容器内），z-index 2147483647。
   */
  function showL2DErrorDialog(error) {
    removeInlineErrorDialog();
    var dialog = document.createElement('div');
    dialog.id = 'dsh-l2d-error-dialog';
    dialog.appendChild(buildL2DErrorCard(document, error));
    document.body.appendChild(dialog);
    dialog.addEventListener('click', function (event) {
      var action = event.target && event.target.dataset ? event.target.dataset.action : null;
      if (!action) return;
      handleL2DErrorAction(action, removeInlineErrorDialog);
    });
  }

  /**
   * 浏览器画中画窗口（Document Picture-in-Picture，Chromium 116+）：
   * 独立小窗、系统级置顶，承载完整错误处理 UI；页内零占用。
   * requestWindow 需要 transient user activation——自动弹出被拒时由
   * openL2DErrorUi 降级页内卡片，用户点 48×48 徽标后必能开窗。
   * PiP 是独立 document：主文档样式表不生效，须注入自包含 ERROR_DIALOG_CSS。
   */
  function openPipErrorDialog(error) {
    var pip = window.documentPictureInPicture;
    if (!pip || typeof pip.requestWindow !== 'function') {
      return Promise.reject(new Error('pip-unsupported'));
    }
    return pip.requestWindow({ width: 360, height: 340 }).then(function (pipWin) {
      var doc = pipWin.document;
      try { doc.title = 'Live2D 恢复'; } catch (err) { /* ignore */ }
      try {
        var style = doc.createElement('style');
        style.textContent = ERROR_DIALOG_CSS;
        doc.head.appendChild(style);
      } catch (err) { /* ignore */ }
      removeInlineErrorDialog(); // PiP 开成功 → 页内卡片不再需要
      var card = buildL2DErrorCard(doc, error);
      doc.body.appendChild(card);
      card.addEventListener('click', function (event) {
        var action = event.target && event.target.dataset ? event.target.dataset.action : null;
        if (!action) return;
        handleL2DErrorAction(action, function () {
          try { pipWin.close(); } catch (err) { /* ignore */ }
        });
      });
      // 用户手动关窗：页内 48×48 徽标仍在，可再次点击打开
      pipWin.addEventListener('pagehide', function () { /* no-op：徽标即入口 */ });
      return pipWin;
    });
  }

  /** 错误处理统一入口：PiP 优先，失败降级页内右下角卡片。 */
  function openL2DErrorUi(error) {
    openPipErrorDialog(error).catch(function () { showL2DErrorDialog(error); });
  }
  // 性能：挂件显示尺寸 593×741，4096 贴图（5×64MiB=320MiB 显存）纯属浪费；
  // 2048 档肉眼无差，显存降到 80MiB、采样带宽降到 1/4。
  // [#28] 模型入口不再写死大肥鱼：先问服务端 status.json（按 MODEL_DIR 发现的
  // 当前模型），不可达时回落 2048 档。换模型 / 换目录不再 404。
  var MODEL_URL_FALLBACK =
    '/dsh-l2d/model/' + encodeURIComponent('大肥鱼.dsl2d.2048.model3.json');
  var resolvedModelUrl = null;
  function resolveModelUrl() {
    if (resolvedModelUrl) return Promise.resolve(resolvedModelUrl);
    return fetch('/dsh-l2d/status.json', { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (s) {
        resolvedModelUrl =
          s && s.model
            ? '/dsh-l2d/model/' + encodeURIComponent(s.model)
            : MODEL_URL_FALLBACK;
        return resolvedModelUrl;
      })
      .catch(function () {
        resolvedModelUrl = MODEL_URL_FALLBACK;
        return resolvedModelUrl;
      });
  }

  /**
   * 渲染倍率：高 DPI/Retina 按 devicePixelRatio 走（Mac Retina=2、Windows 150%=1.5）。
   * dpr=1 的普通屏**不再固定 2× 超采样**：实测它把 593×741 的挂件画成 1186×1482，
   * 填充率 ×4，是有交互时掉到 38fps 的主因。要清晰档把返回改回 Math.max(2, ...) 即可。
   * 前台按 devicePixelRatio 夹 1~2×（上限 2×），失焦/隐藏降到 1× 省 GPU 填充与带宽，回前台立即恢复；
   * 画布单边/总像素的 8K 护栏在渲染包 resizeCanvas 内统一钳制。
   */
  function renderScale() {
    var dpr = Number(window.devicePixelRatio) || 1;
    if (document.hidden === true) return 1;
    if (document.hasFocus && !document.hasFocus()) return 1;
    return Math.max(1, Math.min(2, Math.round(dpr * 100) / 100));
  }

  function loadScriptOnce(id, src) {
    return new Promise(function (resolve, reject) {
      if (document.getElementById(id)) return resolve();
      var s = document.createElement('script');
      s.id = id;
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('加载失败: ' + src)); };
      document.head.appendChild(s);
    });
  }

  function canvasBox() {
    var w = 0;
    var h = 0;
    try {
      if (root) {
        var r = root.getBoundingClientRect();
        w = Math.round(r.width);
        h = Math.round(r.height);
      }
    } catch (e) { /* ignore */ }
    if (!w || !h) {
      // 容器尚未布局完成（或窗口被遮挡）时，按当前缩放算一个确定尺寸，避免 0×0
      var sc = Math.min(2.0, Math.max(0.6, Number(settings.scale) || 1));
      w = Math.round(320 * sc * bodyTypeFactor());
      h = Math.round(400 * sc * bodyTypeFactor());
    }
    return { w: w, h: h };
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { resolve(); });
    });
  }

  // 尺寸变化时重排，替代手工在各处调用 layout
  function watchResize() {
    if (typeof ResizeObserver !== 'function' || !root) return;
    var last = { w: 0, h: 0 };
    try {
      var ro = new ResizeObserver(function () {
        var box = canvasBox();
        if (box.w === last.w && box.h === last.h) return;
        last = box;
        if (!rendererReady) return;
        if (canvasEl) {
          canvasEl.style.width = box.w + 'px';
          canvasEl.style.height = box.h + 'px';
        }
        if (window.DSH_L2D && window.DSH_L2D.layout) window.DSH_L2D.layout(box.w, box.h, 1, renderScale());
        reanchorGaze(); // 容器尺寸变了，脸部锚点也变了
      });
      ro.observe(root);
    } catch (e) { /* ignore */ }
  }

  // 跨屏拖动（外接屏切换、Mac 从 Retina 拖到普通屏）时 devicePixelRatio 会变：
  // 监听分辨率匹配变化，按新倍率重排画布。
  var dprWatch = null;
  function watchDpr() {
    if (typeof window.matchMedia !== 'function') return;
    if (dprWatch && dprWatch.removeEventListener) dprWatch.removeEventListener('change', onDprChanged);
    try {
      dprWatch = window.matchMedia('(resolution: ' + (Number(window.devicePixelRatio) || 1) + 'dppx)');
      dprWatch.addEventListener('change', onDprChanged);
    } catch (e) { /* ignore */ }
  }
  function onDprChanged() {
    watchDpr();
    if (rendererReady && window.DSH_L2D && window.DSH_L2D.layout) {
      var box = canvasBox();
      window.DSH_L2D.layout(box.w, box.h, 1, renderScale());
      reanchorGaze();
    }
  }

  // 焦点/可见性变化时重算超采样倍率：前台按 dpr 夹 1~2×，失焦/隐藏 1×。
  // 这是"回前台就顺滑、切走就省电"的关键一环，和渲染包的帧率守卫配合。
  function applyRenderScale() {
    if (!rendererReady || !window.DSH_L2D || !window.DSH_L2D.layout) return;
    try {
      var box = canvasBox();
      window.DSH_L2D.layout(box.w, box.h, 1, renderScale());
      reanchorGaze();
    } catch (e) { /* 渲染包未就绪时忽略，下次事件再算 */ }
  }
  var focusScaleBound = false;
  function watchFocusScale() {
    if (focusScaleBound) return;
    focusScaleBound = true;
    window.addEventListener('focus', applyRenderScale);
    window.addEventListener('blur', applyRenderScale);
    document.addEventListener('visibilitychange', applyRenderScale);
  }

  function fallbackToImage(reason) {
    rendererFailed = true;
    if (canvasEl) canvasEl.style.display = 'none';
    if (imgEl) {
      imgEl.style.display = 'block';
      if (!imgEl.src) imgEl.src = '/dsh-l2d/avatar.png?v=' + Date.now();
    }
    if (reason) console.warn('[dsh-l2d] 回退到静态立绘: ' + reason);
  }

  function initRenderer() {
    if (rendererReady) return;
    if (L2D_RECOVERY.moduleDisabled || L2D_RECOVERY.modelDisabled) return;
    // P0 修复：rendererFailed 不再永久锁死——重试路径先重置它（retryL2DRenderer）。
    // 首启兜底：如果带着 failed 状态被直接调进来（旧宿主时序），也允许重试一轮。
    setL2DState('loading');

    // generation：本轮加载的代数 id。旧代（超时后才完成的）mount 结果作废，
    // 防止旧挂载完成时覆盖新一轮状态、产生双渲染实例。
    var gen = ++L2D_RECOVERY.generation;

    // 15s 单次加载超时：挂起/卡死不再无限等待
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error('Live2D 初始化超时(' + L2D_RECOVERY.loadTimeoutMs / 1000 + 's)'));
      }, L2D_RECOVERY.loadTimeoutMs);
    });

    var loading = resolveModelUrl().then(function (modelUrl) {
      return loadScriptOnce('dsh-l2d-core', versioned('/dsh-l2d/core.js'))
        .then(function () {
          if (!window.Live2DCubismCore) throw new Error('Core 未挂载');
          return loadScriptOnce('dsh-l2d-renderer', versioned('/dsh-l2d/renderer.js'));
        })
        .then(nextFrame)
        .then(function () {
          if (!window.DSH_L2D || !window.DSH_L2D.mount) throw new Error('渲染包未挂载');
          var box = canvasBox();
          canvasEl.style.width = box.w + 'px';
          canvasEl.style.height = box.h + 'px';
          return window.DSH_L2D.mount(canvasEl, {
            modelUrl: modelUrl,
            width: box.w,
            height: box.h,
            zoom: 1,
            dpr: renderScale()
          });
        });
    });

    Promise.race([loading, timeout])
      .then(function () {
        // 旧代结果作废：新一轮重试已经在跑，旧 mount 完成不覆盖新代状态
        if (gen !== L2D_RECOVERY.generation) return;
        rendererReady = true;
        rendererFailed = false;
        L2D_RECOVERY.attempts = 0;
        L2D_RECOVERY.lastError = null;
        restoreL2DContainer();
        if (imgEl) imgEl.style.display = 'none';
        setL2DState('ready');
        var dialog = document.getElementById('dsh-l2d-error-dialog');
        if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
        watchResize();
        watchDpr(); // 跨屏/缩放变化时按新 DPI 重排
        watchFocusScale(); // 焦点/可见性变化时切换超采样倍率
        bindPhysics(); // 渲染就绪后立刻挂上每帧物理钩子
      })
      .catch(function (err) {
        // 旧代失败作废：新一轮已经在跑，不能把重试轮打断
        if (gen !== L2D_RECOVERY.generation) return;
        rendererReady = false;
        var reason = err && err.message ? err.message : String(err);
        collapseL2DContainer();
        console.error('[dsh-l2d] Renderer failure:', reason);
        scheduleL2DRetry(gen, reason);
      });
  }

  // ---------------------------------------------------------------- 动画
  // 说明：当前是静态立绘，无法只动眼球。真眼动需要写 ParamEyeBallX/Y，
  // 必须等 Cubism 渲染接入后由 ParamMixer 仲裁输出。在此之前不做任何「整图跟随鼠标」，
  // 那种位移会让角色整体漂移，观感是错的。
  // 拖拽面部微放大：拖住时轻微放大贴近（~7%），松手平滑弹回
  var dragZoom = { cur: 1, applied: 1 };
  var lastDragBusy = false;

  function startAnim() {
    var t0 = performance.now();
    function frame(now) {
      var t = (now - t0) / 1000;
      // 拖拽放大缓动
      var zoomTarget = physics.dragging ? 1.07 : 1;
      dragZoom.cur += (zoomTarget - dragZoom.cur) * 0.12;
      var dragBusy = physics.dragging || dragZoom.cur > 1.02;
      if (dragBusy !== lastDragBusy) {
        lastDragBusy = dragBusy;
        var Lbusy = window.DSH_L2D;
        if (Lbusy && Lbusy.setStageBusy) Lbusy.setStageBusy({ dragging: dragBusy });
      }
      if (Math.abs(dragZoom.cur - dragZoom.applied) > 0.002) {
        dragZoom.applied = dragZoom.cur;
        var Lz = window.DSH_L2D;
        if (Lz && Lz.setZoom && rendererReady) Lz.setZoom(dragZoom.cur);
      }
      // 真实模型由 Cubism 物理/动作驱动，不再叠加 CSS 位移
      if (!rendererReady && imgEl && imgEl.style.display !== 'none') {
        var speed = prefs.state === 'conversation' ? 2.2 : prefs.state === 'away' ? 0.45 : 1.05;
        var amp = prefs.state === 'away' ? 1.2 : 3.4;
        var y = Math.sin(t * speed) * amp;
        var r = Math.sin(t * 0.72) * 0.7;
        imgEl.style.transform = 'translateY(' + y.toFixed(2) + 'px) rotate(' + r.toFixed(2) + 'deg)';
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- 兜底
  function observeRemoval() {
    if (typeof MutationObserver !== 'function') return;
    var pending = false;
    var mo = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        if (!document.getElementById(ROOT_ID)) {
          root = null;
          ensureMounted();
        }
      }, 300);
    });
    mo.observe(document.body, { childList: true });
  }

  // ---------------------------------------------------------------- 设置面板
  // 用户自填 API Key / 音效 / 缩放 / 刷新间隔；宿主侧落盘（$DSH_HOME/l2d-settings.json）。
  var panelEl = null;
  var settings = { scale: 1, soundEnabled: true, soundVolume: 0.7, refreshSeconds: 60, hasApiKey: false, eyeFollow: true, agentLink: true, clickMode: 'nodegraph', spontaneousChat: true, memeStyle: true, memeLevel: 50, autoAct: true, systemSensor: false, mediaSensor: false, petMode: true };
  var panelOpen = false;

  // 体型系数：三个体型的可见轮廓不同，用一个统一系数把视觉高度拉回一致。
  // 这里按模型实测微调；后续换模型时只需要改这一张表。
  var BODY_TYPES = [
    { label: '默认体型', value: 0, factor: 1.0 },
    { label: '体型1', value: 0.4, factor: 1.08 },
    { label: '体型2', value: 1.0, factor: 0.95 },
  ];
  var BODY_BASE_W = 320;
  var BODY_BASE_H = 400;

  function bodyTypeFactor() {
    var item = BODY_TYPES[prefs.bodyType] || BODY_TYPES[0];
    return item.factor || 1;
  }

  function applyScale(scale) {
    if (!root) return;
    var sc = Math.min(2.0, Math.max(0.6, Number(scale) || 1));
    settings.scale = sc;
    var factor = bodyTypeFactor();
    var w = Math.round(BODY_BASE_W * sc * factor);
    var h = Math.round(BODY_BASE_H * sc * factor);
    root.style.width = w + 'px';
    root.style.height = h + 'px';
    if (rendererReady && window.DSH_L2D && window.DSH_L2D.layout) {
      if (canvasEl) {
        canvasEl.style.width = w + 'px';
        canvasEl.style.height = h + 'px';
      }
      window.DSH_L2D.layout(w, h, 1);
    }
    // 尺寸变了：重新夹一下位置，别让角色被挤出屏幕
    if (pos.x !== null) {
      var c = clampPos(pos.x, pos.y);
      pos.x = c.x;
      pos.y = c.y;
    }
    applyPos();
  }

  function loadSettings() {
    fetch('/dsh-l2d/settings.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        settings = data;
        // 宿主视图可能不含 petMode（旧宿主/精简宿主）：缺省按正式行为（默认开），显式 false 才关
        settings.petMode = data.petMode !== false;
        applyScale(settings.scale);
        syncSystemSensor();
        syncMediaSensor();
        applyEyeFollowSetting();
        updateMouseGeometry();
      })
      .catch(function () { /* ignore */ });
  }

  /**
   * 强制刷新状态（调试钩子）：重新拉宿主设置 + 销毁并重新挂载渲染包，
   * 不重载整个 DSH 页面。修改设置后状态没生效、渲染卡住、或改了 overlay.js
   * 想当场复位时用。仅控制台可达：window.__DSH_L2D_FORCE_REFRESH__()。
   * UI 入口（设置面板里的按钮）已按降噪需求移除。
   */
  function forceRefreshState() {
    say('正在强制刷新…', 1200);
    // 1) 重拉宿主设置（缩放/传感器开关重新生效）
    loadSettings();
    // 2) 销毁渲染包，清掉旧挂载状态
    var L = window.DSH_L2D;
    if (L && L.destroy) {
      try { L.destroy(); } catch (err) { /* ignore */ }
    }
    rendererReady = false;
    rendererFailed = false;
    // 2.5) 丢掉旧的渲染包 <script> 标签：loadScriptOnce 见到同 id 标签会直接返回，
    //      否则拿到的仍是页面加载时的旧 bundle（改了渲染包后点按钮却不生效的原因）。
    //      注意：这里只能换渲染包；overlay.js 本身的改动仍需要 F5 整页刷新。
    try {
      var stale = document.getElementById('dsh-l2d-renderer');
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    } catch (err) { /* ignore */ }
    if (canvasEl) {
      canvasEl.style.display = '';
      canvasEl.classList.remove('dragging');
    }
    if (imgEl) {
      imgEl.style.display = 'none';
      imgEl.removeAttribute('src');
    }
    // 3) 重挂（initRenderer 里会重新走 Core/渲染包加载与 mount）
    // P0 修复：同步重置恢复状态机计数，清掉未到期的重试定时器
    L2D_RECOVERY.attempts = 0;
    L2D_RECOVERY.modelDisabled = false;
    clearL2DRetryTimer();
    initRenderer();
    say('已强制刷新', 1800);
  }
  try { window.__DSH_L2D_FORCE_REFRESH__ = forceRefreshState; } catch (err) { /* ignore */ }

  function closePanel() {
    if (!panelEl) return;
    panelOpen = false;
    panelEl.classList.remove('open');
  }

  /* 旧内嵌面板已退役（Settings-UI.md §8.3）：所有设置入口改向新设置页抽屉。
    buildPanel 调用已摘除，两套入口不得并存。
    旧面板 DOM 不再构建；openPanel/closePanel/panelOpen 机制保留为防御壳（无入口可达）。 */
  function openSettingsDrawer(group) {
    var mgr = window.DSH_L2D_SettingsWindowManager;
    if (mgr && mgr.open) {
      mgr.open(group);
      return true;
    }
    // settings-entry 注入晚于点击（SPA 时序）：短重试，放弃时安静失败不扰动宿主
    var n = 0;
    var timer = setInterval(function () {
      var m = window.DSH_L2D_SettingsWindowManager;
      if (m && m.open) {
        clearInterval(timer);
        m.open(group);
      } else if (++n > 20) {
        clearInterval(timer);
      }
    }, 250);
    return false;
  }

  function openPanel() {
    if (!panelEl) return;
    panelOpen = true;
    applyPanelPrefs(); // 打开时恢复/夹取位置尺寸（视口可能已变）
    panelEl.classList.add('open');
  }

  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
  }

  // ------------------------------------------------ 浮动窗口（响应式升级版）
  // 几何偏好存 localStorage（非设置数据，不进宿主 settings.json），300ms 防抖写入。
  // 结构：{ maximized, geometry:{x,y,w,h}, previousGeometry, collapsed }
  // 四档断点：≥1200 桌面浮动 / 768-1199 紧凑 / 480-767 窄窗 / ≤479 全屏（去小窗形态）。
  // 拖拽全程 clamp 视口内；最大化/吸附前的几何独立存 previousGeometry，还原时按
  // 当前视口重新 clamp，绝不把旧坐标直接还原进已缩小的视口。
  var PANEL_PREFS_KEY = 'dsh-l2d-panel-prefs';
  var PANEL_MIN_W = 480;
  var PANEL_MIN_H = 360;
  var PANEL_DEFAULT_W = 860;
  var PANEL_DEFAULT_H = 620;
  var PANEL_SNAP_EDGE = 16;
  var panelPrefsSaveTimer = 0;
  var panelGeom = null;      // 当前几何（border-box px），单一事实源
  var panelPrevGeom = null;  // 最大化/吸附前几何
  var panelSnapped = null;   // 运行时吸附态：'left'|'right'|null（不入盘）
  var panelLastTap = 0;      // 标题栏双击判定
  var snapGhostEl = null;

  function panelMode() {
    var vw = window.innerWidth;
    if (vw <= 479) return 'fullscreen';
    if (vw <= 767) return 'narrow';
    if (vw <= 1199) return 'compact';
    return 'desktop';
  }

  function validBox(b) {
    if (!b || typeof b !== 'object') return null;
    var x = Number(b.x), y = Number(b.y), w = Number(b.w), h = Number(b.h);
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
    return { x: x, y: y, w: w, h: h };
  }

  function readPanelPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || 'null');
      if (!p || typeof p !== 'object') return null;
      // 旧结构 {x,y,w,h,collapsed} → 新结构迁移
      if (!p.geometry && p.x != null) {
        p = { maximized: false, geometry: { x: p.x, y: p.y, w: p.w, h: p.h }, previousGeometry: null, collapsed: p.collapsed === true };
      }
      return {
        maximized: p.maximized === true,
        geometry: validBox(p.geometry),
        previousGeometry: validBox(p.previousGeometry),
        collapsed: p.collapsed === true
      };
    } catch (err) { return null; }
  }

  function savePanelPrefs() {
    if (!panelEl) return;
    var prefs = {
      maximized: panelEl.classList.contains('maximized'),
      geometry: panelGeom || undefined,
      previousGeometry: panelPrevGeom || undefined,
      collapsed: panelEl.classList.contains('collapsed')
    };
    try { localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(prefs)); } catch (err) { /* 隐私模式等 */ }
  }

  function savePanelPrefsSoon() {
    if (panelPrefsSaveTimer) clearTimeout(panelPrefsSaveTimer);
    panelPrefsSaveTimer = setTimeout(function () {
      panelPrefsSaveTimer = 0;
      savePanelPrefs();
    }, 300);
  }

  function clampBox(g) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = Math.min(g.w, vw);
    var h = Math.min(g.h, vh);
    return {
      w: w, h: h,
      x: Math.min(Math.max(g.x, 0), Math.max(0, vw - w)),
      y: Math.min(Math.max(g.y, 0), Math.max(0, vh - h))
    };
  }

  function defaultGeom() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = Math.min(PANEL_DEFAULT_W, vw - 24);
    var h = Math.min(PANEL_DEFAULT_H, vh - 48);
    return { x: Math.max(12, Math.round((vw - w) / 2)), y: Math.max(12, Math.round((vh - h) / 2)), w: w, h: h };
  }

  function setGeom(g) {
    panelGeom = { x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.w), h: Math.round(g.h) };
    panelEl.style.left = panelGeom.x + 'px';
    panelEl.style.top = panelGeom.y + 'px';
    panelEl.style.width = panelGeom.w + 'px';
    panelEl.style.height = panelGeom.h + 'px';
  }

  function applyPanelPrefs() {
    if (!panelEl) return;
    var p = readPanelPrefs();
    if (panelMode() === 'fullscreen') {
      panelEl.classList.add('fullscreen');
      panelEl.classList.remove('maximized');
      panelGeom = null;
      panelPrevGeom = p && p.previousGeometry ? p.previousGeometry : null;
      panelEl.style.left = panelEl.style.top = panelEl.style.width = panelEl.style.height = '';
      panelEl.classList.toggle('collapsed', !!(p && p.collapsed));
      return;
    }
    panelEl.classList.remove('fullscreen');
    panelPrevGeom = p && p.previousGeometry ? p.previousGeometry : null;
    panelSnapped = null;
    if (p && p.maximized) {
      panelEl.classList.add('maximized');
      setGeom(clampBox({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }));
    } else {
      panelEl.classList.remove('maximized');
      setGeom(clampBox(p && p.geometry ? p.geometry : defaultGeom()));
    }
    panelEl.classList.toggle('collapsed', !!(p && p.collapsed));
  }

  function toggleMaximize() {
    if (!panelEl || !panelOpen || panelMode() === 'fullscreen') return;
    if (panelEl.classList.contains('maximized')) {
      panelEl.classList.remove('maximized');
      var g = panelPrevGeom || defaultGeom();
      panelPrevGeom = null;
      setGeom(clampBox(g)); // 按当前视口重新 clamp 后还原
    } else {
      panelPrevGeom = panelGeom || defaultGeom();
      panelEl.classList.add('maximized');
      setGeom({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    }
    savePanelPrefsSoon();
  }

  function showSnapGhost(zone) {
    if (!zone) {
      if (snapGhostEl) snapGhostEl.classList.remove('on');
      return;
    }
    if (!snapGhostEl) {
      snapGhostEl = document.createElement('div');
      snapGhostEl.className = 'l2d-snap-ghost';
      document.body.appendChild(snapGhostEl);
    }
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var r = zone === 'top' ? { x: 0, y: 0, w: vw, h: vh }
      : zone === 'left' ? { x: 0, y: 0, w: Math.round(vw / 2), h: vh }
        : { x: Math.round(vw / 2), y: 0, w: Math.round(vw / 2), h: vh };
    snapGhostEl.style.left = r.x + 'px';
    snapGhostEl.style.top = r.y + 'px';
    snapGhostEl.style.width = r.w + 'px';
    snapGhostEl.style.height = r.h + 'px';
    snapGhostEl.classList.add('on');
  }

  function applySnap(zone) {
    if (!panelEl || !panelOpen) return;
    if (zone === 'top') { toggleMaximize(); return; }
    if (!panelEl.classList.contains('maximized')) panelPrevGeom = panelGeom;
    panelEl.classList.remove('maximized');
    panelSnapped = zone;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    setGeom(zone === 'left' ? { x: 0, y: 0, w: Math.round(vw / 2), h: vh } : { x: Math.round(vw / 2), y: 0, w: Math.round(vw / 2), h: vh });
    savePanelPrefsSoon();
  }

  function bindPanelWindow() {
    if (!panelEl) return;
    var head = panelEl.querySelector('.l2d-panel-head');
    var closeBtn = panelEl.querySelector('.l2d-panel-close');
    var maxBtn = panelEl.querySelector('.l2d-panel-max');
    var collapseBtn = panelEl.querySelector('.l2d-panel-collapse');

    if (closeBtn) closeBtn.addEventListener('click', function () { closePanel(); });
    if (maxBtn) maxBtn.addEventListener('click', toggleMaximize);
    if (collapseBtn) {
      collapseBtn.addEventListener('click', function () {
        panelEl.classList.toggle('collapsed');
        savePanelPrefsSoon();
      });
    }

    // 八向缩放：委托 handler 按 data-dir 计算，对边固定；最大化/全屏态隐藏手柄
    panelEl.addEventListener('pointerdown', function (e) {
      var grip = e.target.closest ? e.target.closest('.l2d-ph') : null;
      if (!grip || e.button !== 0) return;
      if (panelEl.classList.contains('maximized') || panelEl.classList.contains('fullscreen')) return;
      e.preventDefault();
      e.stopPropagation();
      var dir = grip.getAttribute('data-dir');
      var box0 = panelEl.getBoundingClientRect();
      var startX = e.clientX;
      var startY = e.clientY;
      function onMove(ev) {
        var g = { x: box0.left, y: box0.top, w: box0.width, h: box0.height };
        var dx = ev.clientX - startX;
        var dy = ev.clientY - startY;
        if (dir.indexOf('e') >= 0) g.w = Math.min(window.innerWidth - g.x, Math.max(PANEL_MIN_W, box0.width + dx));
        if (dir.indexOf('s') >= 0) g.h = Math.min(window.innerHeight - g.y, Math.max(PANEL_MIN_H, box0.height + dy));
        if (dir.indexOf('w') >= 0) {
          var right = box0.left + box0.width;
          g.w = Math.min(right, Math.max(PANEL_MIN_W, box0.width - dx));
          g.x = right - g.w;
        }
        if (dir.indexOf('n') >= 0) {
          var bottom = box0.top + box0.height;
          g.h = Math.min(bottom, Math.max(PANEL_MIN_H, box0.height - dy));
          g.y = bottom - g.h;
        }
        setGeom(g);
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.body.classList.remove('l2d-panel-interacting');
        savePanelPrefsSoon();
      }
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.body.classList.add('l2d-panel-interacting');
    });

    if (head) {
      head.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        if (e.target.closest && e.target.closest('.l2d-panel-btn')) return;
        if (panelMode() === 'fullscreen') return; // 全屏态：头部仅作标题，不拖拽
        // 双击标题栏最大化/还原：pointerdown 计时判定，不依赖浏览器 dblclick 兼容链
        var now = Date.now();
        if (now - panelLastTap < 350) {
          panelLastTap = 0;
          toggleMaximize();
          return;
        }
        panelLastTap = now;
        // 最大化/吸附态：单击先布防，只有出现真实位移才还原并转拖拽
        // （否则双击还原会被第一次 down 的「拖拽即还原」抢走，第二次 down 又 toggle 回去）。
        var box0 = panelEl.getBoundingClientRect();
        var offX = e.clientX - box0.left;
        var offY = e.clientY - box0.top;
        var snapZone = null;
        var restored = !panelEl.classList.contains('maximized') && !panelSnapped;
        function ensureRestore(curX, curY) {
          if (restored) return box0;
          var prev = panelPrevGeom || defaultGeom();
          panelEl.classList.remove('maximized');
          panelSnapped = null;
          setGeom(clampBox({ x: curX - prev.w / 2, y: curY - 18, w: prev.w, h: prev.h }));
          restored = true;
          return panelEl.getBoundingClientRect();
        }
        function onMove(ev) {
          if (!restored) {
            if (Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) return;
            box0 = ensureRestore(ev.clientX, ev.clientY);
            offX = Math.min(box0.width - 40, Math.max(40, ev.clientX - box0.left));
            offY = 18;
          }
          setGeom(clampBox({ x: ev.clientX - offX, y: ev.clientY - offY, w: box0.width, h: box0.height }));
          var z = null;
          if (ev.clientY <= PANEL_SNAP_EDGE) z = 'top';
          else if (ev.clientX <= PANEL_SNAP_EDGE) z = 'left';
          else if (ev.clientX >= window.innerWidth - PANEL_SNAP_EDGE) z = 'right';
          if (z !== snapZone) { snapZone = z; showSnapGhost(z); }
        }
        function onUp() {
          document.removeEventListener('pointermove', onMove, true);
          document.removeEventListener('pointerup', onUp, true);
          document.body.classList.remove('l2d-panel-interacting');
          showSnapGhost(null);
          if (snapZone) applySnap(snapZone);
          else if (restored) savePanelPrefsSoon();
        }
        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.body.classList.add('l2d-panel-interacting');
      });
    }
  }

  // Esc 关闭（键盘可达）；视口/断点变化时重排（ResizeObserver + matchMedia，
  // 不依赖固定分辨率；跨断点时浮动↔全屏形态切换）
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panelOpen) closePanel();
  });
  function panelViewportChanged() {
    if (!panelOpen || !panelEl) return;
    var wasFullscreen = panelEl.classList.contains('fullscreen');
    if (panelMode() === 'fullscreen' || wasFullscreen) {
      applyPanelPrefs(); // 跨断点：形态重算
      return;
    }
    if (panelEl.classList.contains('maximized')) {
      setGeom(clampBox({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }));
    } else if (panelGeom) {
      setGeom(clampBox(panelGeom));
    }
    savePanelPrefsSoon();
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(panelViewportChanged).observe(document.documentElement);
  }
  window.addEventListener('resize', panelViewportChanged);

  function row(labelText, control, group) {
    var wrap = document.createElement('div');
    wrap.className = 'l2d-row';
    if (group) wrap.setAttribute('data-group', group); // 设置入口二级菜单锚点
    var lab = document.createElement('label');
    lab.textContent = labelText;
    wrap.appendChild(lab);
    wrap.appendChild(control);
    return wrap;
  }

  function buildPanel() {
    if (!panelEl) return;
    panelEl.innerHTML = '';
    panelEl.classList.remove('collapsed');

    // 标题栏：拖拽把手 + 折叠/最大化/关闭。内容全部收进 .l2d-panel-body，由滚动条兜底。
    var head = document.createElement('div');
    head.className = 'l2d-panel-head';
    head.setAttribute('tabindex', '-1'); // SettingsWindowManager 焦点落点
    var title = document.createElement('h4');
    title.textContent = 'DSH-L2D 设置';
    var collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'l2d-panel-btn l2d-panel-collapse';
    collapseBtn.textContent = '\u2013';
    collapseBtn.setAttribute('aria-label', '折叠设置面板');
    collapseBtn.title = '折叠';
    var maxBtn = document.createElement('button');
    maxBtn.type = 'button';
    maxBtn.className = 'l2d-panel-btn l2d-panel-max';
    maxBtn.textContent = '\u25a1';
    maxBtn.setAttribute('aria-label', '最大化/还原');
    maxBtn.title = '最大化 / 还原（双击标题栏同效）';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'l2d-panel-btn l2d-panel-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.setAttribute('aria-label', '关闭设置');
    closeBtn.title = '关闭';
    head.appendChild(title);
    head.appendChild(collapseBtn);
    head.appendChild(maxBtn);
    head.appendChild(closeBtn);
    panelEl.appendChild(head);

    var body = document.createElement('div');
    body.className = 'l2d-panel-body';

    var keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = settings.hasApiKey ? '已保存，留空则不修改' : 'sk-...';
    keyInput.autocomplete = 'off';
    body.appendChild(row('DeepSeek API Key（仅用于查询余额）', keyInput, 'account'));

    var soundWrap = document.createElement('div');
    soundWrap.className = 'l2d-inline';
    var soundToggle = document.createElement('input');
    soundToggle.type = 'checkbox';
    soundToggle.checked = settings.soundEnabled !== false;
    var soundVol = document.createElement('input');
    soundVol.type = 'range';
    soundVol.min = '0';
    soundVol.max = '1';
    soundVol.step = '0.05';
    soundVol.value = String(settings.soundVolume);
    soundWrap.appendChild(soundToggle);
    soundWrap.appendChild(soundVol);
    body.appendChild(row('音效开关 / 音量', soundWrap, 'behavior'));

    var scaleInput = document.createElement('input');
    scaleInput.type = 'range';
    scaleInput.min = '0.6';
    scaleInput.max = '2.0';
    scaleInput.step = '0.05';
    scaleInput.value = String(settings.scale);
    scaleInput.addEventListener('input', function () {
      applyScale(scaleInput.value);
    });
    body.appendChild(row('角色缩放', scaleInput, 'appearance'));

    var refreshInput = document.createElement('input');
    refreshInput.type = 'number';
    refreshInput.min = '15';
    refreshInput.max = '3600';
    refreshInput.value = String(settings.refreshSeconds);
    body.appendChild(row('余额刷新间隔（秒）', refreshInput, 'account'));

    var agentToggle = document.createElement('input');
    agentToggle.type = 'checkbox';
    agentToggle.checked = settings.agentLink !== false;
    body.appendChild(row('工作区联动', agentToggle, 'behavior'));
    var sysToggle = document.createElement('input');
    sysToggle.type = 'checkbox';
    sysToggle.checked = settings.systemSensor === true;
    body.appendChild(row('系统联动（CPU/内存/电量/断网）', sysToggle, 'behavior'));
    var mediaToggle = document.createElement('input');
    mediaToggle.type = 'checkbox';
    mediaToggle.checked = settings.mediaSensor === true;
    body.appendChild(row('媒体律动（音乐播放时轻摆）', mediaToggle, 'behavior'));

    var petToggle = document.createElement('input');
    petToggle.type = 'checkbox';
    petToggle.checked = settings.petMode !== false; // 默认开（桌宠模式为正式行为）
    body.appendChild(row('桌宠模式（悬停零触发 · 点击只摸头）', petToggle, 'behavior'));

    var eyeFollowToggle = document.createElement('input');
    eyeFollowToggle.type = 'checkbox';
    eyeFollowToggle.checked = settings.eyeFollow !== false; // 默认开（与宿主默认值/存量迁移一致）
    body.appendChild(row('眼神跟随（鼠标驱动视线/头/身体）', eyeFollowToggle, 'appearance'));

    var clickMode = document.createElement('select');
    var modeNodegraph = document.createElement('option');
    modeNodegraph.value = 'nodegraph';
    modeNodegraph.textContent = '节点图编排（推荐）';
    var modeRandom = document.createElement('option');
    modeRandom.value = 'random';
    modeRandom.textContent = '随机动作';
    var modeApi = document.createElement('option');
    modeApi.value = 'api';
    modeApi.textContent = 'DeepSeek 决定';
    clickMode.appendChild(modeNodegraph);
    clickMode.appendChild(modeRandom);
    clickMode.appendChild(modeApi);
    clickMode.value = settings.clickMode === 'api' ? 'api' : settings.clickMode === 'nodegraph' ? 'nodegraph' : 'random';
    body.appendChild(row('戳一戳动作', clickMode, 'behavior'));

    var spontaneousChat = document.createElement('input');
    spontaneousChat.type = 'checkbox';
    spontaneousChat.checked = settings.spontaneousChat !== false;
    body.appendChild(row('自发聊天', spontaneousChat, 'behavior'));

    var memeToggle = document.createElement('input');
    memeToggle.type = 'checkbox';
    memeToggle.checked = settings.memeStyle !== false;
    body.appendChild(row('梗味人设', memeToggle, 'behavior'));

    var memeLevel = document.createElement('input');
    memeLevel.type = 'range';
    memeLevel.min = '0';
    memeLevel.max = '100';
    memeLevel.step = '5';
    memeLevel.value = String(settings.memeLevel);
    body.appendChild(row('玩梗程度', memeLevel, 'behavior'));

    var autoAct = document.createElement('input');
    autoAct.type = 'checkbox';
    autoAct.checked = settings.autoAct !== false;
    body.appendChild(row('API 自主动作', autoAct, 'behavior'));

    var hint = document.createElement('div');
    hint.className = 'l2d-hint';
    hint.textContent = '单击角色播放动作；悬停显示余额与当前峰/谷价。开启自发聊天后，完成状态会回流最新回复，空闲时偶尔说话。';
    body.appendChild(hint);

    var actions = document.createElement('div');
    actions.className = 'l2d-actions';

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', function () {
      buildPanel();
      closePanel();
    });

    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary';
    save.textContent = '保存';
    save.addEventListener('click', function () {
      var patch = {
        soundEnabled: soundToggle.checked,
        soundVolume: Number(soundVol.value),
        scale: Number(scaleInput.value),
        refreshSeconds: Number(refreshInput.value),
        agentLink: agentToggle.checked,
        clickMode: clickMode.value,
        spontaneousChat: spontaneousChat.checked,
        memeStyle: memeToggle.checked,
        memeLevel: Number(memeLevel.value),
        autoAct: autoAct.checked,
        systemSensor: sysToggle.checked,
        mediaSensor: mediaToggle.checked,
        petMode: petToggle.checked,
        eyeFollow: eyeFollowToggle.checked
      };
      if (keyInput.value.trim()) patch.apiKey = keyInput.value.trim();
      fetch('/dsh-l2d/settings.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data) {
            settings = data;
            applyScale(settings.scale);
            syncSystemSensor();
            syncMediaSensor();
            applyEyeFollowSetting();
            updateMouseGeometry();
          }
          say('设置已保存', 1800);
          buildPanel();
          closePanel();
        })
        .catch(function () {
          say('保存失败', 1800);
        });
    });

    actions.appendChild(cancel);
    actions.appendChild(save);
    body.appendChild(actions);
    panelEl.appendChild(body);

    // 八向缩放手柄（N/S/E/W + 四角，方向光标由 CSS 决定）
    var DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (var di = 0; di < DIRS.length; di++) {
      var grip = document.createElement('div');
      grip.className = 'l2d-ph';
      grip.setAttribute('data-dir', DIRS[di]);
      grip.setAttribute('aria-hidden', 'true');
      panelEl.appendChild(grip);
    }

    bindPanelWindow();
  }

  // 启动：初始化链任何一步抛错都不能让整个 IIFE 死掉——否则后面的 DSH_L2D_AI
  // 赋值、AI 轮询、事件桥全部不执行（App 页"角色可见但桥死"就是这种形态）。
  // catch 里做两件事：① 把原因送回宿主（error 在反向桥白名单内，落 reverse/state.json，
  // 以后不用 F12 也能查）；② 补挂 AI 轮询，保证 MCP 指令通道活着。
  function bootOverlay() {
    // P0 修复：用户裁决「禁用整个模组」后 localStorage 持久化——刷新页面/重启宿主
    // 都不再注入角色，但 DSH 主界面、聊天、Agent、MCP 等核心功能全部照常。
    // 恢复方式：① 地址栏访问 http://<host>:<port>/?l2d-enable=1（本旁路，禁用后
    // 页内 gear 菜单已消失，控制台不是普通用户可达的入口）；② 控制台
    // localStorage.removeItem('dsh-l2d.disabled') 后刷新。
    try {
      if (/[?&]l2d-enable=1/.test(location.search)) localStorage.removeItem('dsh-l2d.disabled');
      if (localStorage.getItem('dsh-l2d.disabled') === 'true') return;
    } catch (err) { /* localStorage 不可用（隐私模式等）按未禁用处理 */ }
    try {
      ensureMounted();
      loadDbActions(); // UI-FLOAT ⑤：动作池读库（失败静默降级）
    } catch (err) {
      try {
        fetch('/dsh-l2d/reverse/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'error',
            payload: { reason: String((err && err.message) || err).slice(0, 120) },
          }),
        }).catch(function () { /* 宿主不可达时静默 */ });
      } catch (e2) { /* ignore */ }
      try { startAiPoll(); } catch (e3) { /* ignore */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootOverlay);
  } else {
    // 脚本被注入到已加载完成的页面（DSH App 的 dsh-app:// 壳）时 readyState 是 complete。
    // 这里若同步调用 bootOverlay，IIFE 后面的 var 赋值（agentLink / mediaSensorState /
    // DSH_L2D_AI 等）还没执行，ensureMounted → syncMediaSensor 会因 mediaSensorState
    // 为 undefined 抛 "reading 'timer'"，整个初始化链中断。推迟到宏任务，保证 IIFE 先跑完。
    setTimeout(bootOverlay, 0);
  }

  // ---------------------------------------------------------------- 工作区会话联动
  //
  // 参照 dsh-pet-indesktop 的 Agent Link：读取 DSH 会话事件并聚合为状态，
  // 状态切换时触发一条轻量动作链（表情/视线/姿势），不做高频重播。
  // agentLink 已在模块顶部初始化（见文件头注释）。
  var IDLE_LINES = [
    '我在呢～',
    '你继续忙，我陪你。',
    '刚活动了一下尾巴。',
    '要看会代码吗？',
    '别熬太久哦。',
    '嘿嘿，戳我一下嘛。',
  ];

  function trimChatText(text, max) {
    return String(text || '')
      .replace(/<mood>[^<]*<\/mood>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\r\n\s`>*#\-\[\]]+/, '')
      .trim()
      .slice(0, max || 60);
  }

  function speakSpontaneous(text, minGapMs) {
    if (settings.spontaneousChat === false || !text) return false;
    if (env.away) return false; // 离席：只做低成本表现，不刷气泡
    var now = Date.now();
    if (now - agentLink.lastSpokeAt < (minGapMs || 8000)) return false;
    agentLink.lastSpokeAt = now;
    say(text, 5200);
    return true;
  }

  function agentAct(priority, source, steps) {
    executePokeAction({
      priority: priority,
      source: source,
      silent: true,
      chain: steps,
    });
  }

  var AGENT_CHAIN = {
    thinking: function () {
      agentAct('NORMAL', 'agent', [
        { kind: 'expression', name: '＞＜' },
        { kind: 'look', x: 0, y: 0.28, delayMs: 80 },
      ]);
    },
    working: function () {
      agentAct('NORMAL', 'agent', [
        { kind: 'expression', name: '加载' },
        { kind: 'look', x: 0.2, y: 0.1, delayMs: 80 },
      ]);
    },
    // 回复演出由下面的 chatActionForReply 以 FORCE 占槽，这里不再直接改表情。
    attention: function () {},
    error: function () {
      agentAct('NORMAL', 'agent', [
        { kind: 'expression', name: '流冷汗' },
        { kind: 'look', x: 0, y: -0.18, delayMs: 80 },
      ]);
    },
    idle: function () {
      // 待机只做 BACKGROUND。对话演出和邪神占着 FORCE 时，这一眼不会被放行。
      agentAct('BACKGROUND', 'idle', [{ kind: 'look', x: 0, y: 0 }]);
    },
  };

  var lastMoodText = '';

  function feedMoodFromText(text) {
    var raw = String(text || '');
    if (!raw || raw === lastMoodText) return;
    lastMoodText = raw;
    var name = moodFromText(raw);
    if (!name || !window.DSH_L2D || !window.DSH_L2D.emotionSignal) return;
    window.DSH_L2D.emotionSignal({ type: 'mood', data: { mood: name } });
  }

  function reactAgentState(next, meta) {
    if (env.away) return; // 离席：不演工作区状态反应，回来后再按最新状态补
    var now = Date.now();
    // 同一状态下的新回复也要喂情绪；有 <mood> 用标签，没有就用关键词
    try {
      feedMoodFromText(meta && meta.lastAssistantText);
    } catch (e2) {
      /* 情绪信号失败忽略 */
    }
    if (next === agentLink.state) return;
    agentLink.state = next;
    agentLink.lastAt = now;
    try {
      // error 与「从 error 恢复」都要喂：只喂 error 的话，路由永远收不到恢复信号，
      // 角色会一直挂着出错表情（实测 lastError 已空、ctx 仍是 error）。
      if ((next === 'error' || agentLink.prevState === 'error') &&
          window.DSH_L2D && window.DSH_L2D.emotionSignal) {
        window.DSH_L2D.emotionSignal({ type: 'state', data: { state: next } });
      }
    } catch (e3) {
      /* 情绪信号失败忽略 */
    }
    agentLink.prevState = next;
    // 动作链失败不能打断后续状态联动
    try {
      if (AGENT_CHAIN[next]) AGENT_CHAIN[next]();
      if (next === 'working' && meta && meta.lastTool) {
        say('正在' + meta.lastTool + '…', 2400);
      } else if (next === 'error' && meta && meta.lastError) {
        say('出错了：' + String(meta.lastError).slice(0, 60), 4200);
      } else if (next === 'attention') {
        // 自发聊天：回复回流短气泡，并根据文本映射一条轻量动作链
        var reply = trimChatText(meta && meta.lastAssistantText, 60);
        var chatAction = chatActionForReply(reply);
        executePokeAction(chatAction);
        if (!speakSpontaneous(reply, 3000)) say('我看完啦，等你下一句', 2400);
      }
    } catch (e) {
      console.warn('[dsh-l2d] agent chain failed', e);
    }
  }

  function startIdleChat() {
    if (agentLink.idleTimer) return;
    var tick = function () {
      // 8~18 秒一次；只有长期空闲、无拖拽、无面板打开才说话
      if (
        settings.spontaneousChat !== false &&
        settings.agentLink !== false &&
        !env.away &&
        agentLink.state === 'idle' &&
        !physics.dragging &&
        !panelOpen &&
        window.DSH_L2D && window.DSH_L2D.isReady && window.DSH_L2D.isReady()
      ) {
        speakSpontaneous(randomOf(IDLE_LINES), 12000);
      }
      agentLink.idleTimer = setTimeout(tick, 8000 + Math.random() * 10000);
    };
    agentLink.idleTimer = setTimeout(tick, 12000);
  }

  function startIdleAutoAct() {
    if (agentLink.autoActTimer) return;
    // 自动化测试可通过 ?noauto=1 关掉，避免后台动作污染断言
    if (new URLSearchParams(location.search).get('noauto') === '1') return;
    var tick = function () {
      if (
        settings.autoAct !== false &&
        settings.agentLink !== false &&
        !env.away &&
        agentLink.state === 'idle' &&
        !physics.dragging &&
        !panelOpen &&
        window.DSH_L2D && window.DSH_L2D.isReady && window.DSH_L2D.isReady() &&
        Date.now() - agentLink.lastSpokeAt > 10000
      ) {
        pokeByApi(true);
      }
      agentLink.autoActTimer = setTimeout(tick, 42000 + Math.random() * 45000);
    };
    agentLink.autoActTimer = setTimeout(tick, 30000);
  }

  function startAgentPoll() {
    if (agentLink.timer) return;
    agentLink.timer = setInterval(function () {
      if (settings.agentLink === false) return;
      fetch('/dsh-l2d/agent-state.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          window.__DSH_L2D_AGENT__ = d;
          if (!d || !d.state) return;
          reactAgentState(String(d.state), d);
        })
        .catch(function () { /* 下一轮再试 */ });
    }, 2500);
    startIdleChat();
    startIdleAutoAct();
  }

  // ---------------------------------------------------------------- 情绪传感器
  //
  // Emotion_Router 的信号源。鼠标传感器常开（眼神/躯体跟随的基础，开销可忽略）；
  // 系统硬件监听（CPU/内存/电量/断网）按约束默认关闭，设置面板可开。
  var emotionSensors = { mouseBound: false, sysTimer: 0, batteryBound: false, batteryInstance: null, batteryPush: null, sysGen: 0, vx: 0, vy: 0 };

  function emotionPush(signal) {
    var L = window.DSH_L2D;
    if (L && L.emotionSignal) {
      try {
        L.emotionSignal(signal);
      } catch (e) {
        /* 信号失败忽略 */
      }
    }
  }

  /** 记录鼠标诊断几何（HUD 用）：窗口尺寸、脸部锚点、角色盒位置 */
  function updateMouseGeometry() {
    if (!root) return null;
    var rect = root.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    var probe = window.__DSH_L2D_MOUSE__ = window.__DSH_L2D_MOUSE__ || { moves: 0 };
    probe.winW = Math.round(window.innerWidth || 0);
    probe.winH = Math.round(window.innerHeight || 0);
    // 锚点 = 角色脸部（盒子上部 35%），不是屏幕中心：
    // 模型被拖走后锚点随盒子自动更新，注视不会错位。
    probe.cx = Math.round(rect.left + rect.width / 2);
    probe.cy = Math.round(rect.top + rect.height * 0.35);
    probe.rectW = Math.round(rect.width);
    probe.rectH = Math.round(rect.height);
    probe.rectX = Math.round(rect.left);
    probe.rectY = Math.round(rect.top);
    return probe;
  }

  /** 「眼睛跟随鼠标」关掉时清一次注视，让视线回待机漂移；开回来由 pointermove 重新驱动 */
  /**
   * 设置热更新：overlay 只在 boot/面板保存时读 settings.json，外部 PUT 不会通知页面。
   * 这里每 2.5s 轻量拉一次，只关心 eyeFollow（变化才应用），避免整份覆盖设置与面板改动打架。
   */
  function applyRemoteEyeFollow(value) {
    var next = value !== false;
    var current = settings.eyeFollow !== false;
    if (next === current) return false;
    settings.eyeFollow = next;
    applyEyeFollowSetting();
    // 立即把新状态上报一次（关闭后 env 心跳停发，宿主需要这最后一帧知道
    // inputFocused/away 已停用；否则 env-state 会停留在旧值）
    postEnvPresence('state', { reason: 'eyeFollow-' + next }, { force: true });
    publishPresence();
    console.info('[dsh-l2d] eyeFollow -> ' + next + '（外部设置热更新）');
    return true;
  }

  function startSettingsWatch() {
    if (settingsWatch.timer) return;
    settingsWatch.lastEyeFollow = settings.eyeFollow !== false;
    settingsWatch.timer = setInterval(function () {
      fetch('/dsh-l2d/settings.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || typeof data.eyeFollow !== 'boolean') return;
          settingsWatch.lastEyeFollow = data.eyeFollow;
          applyRemoteEyeFollow(data.eyeFollow);
        })
        .catch(function () { /* 宿主不在或网络抖动：下一轮再试 */ });
    }, 2500);
  }

  /**
   * 关掉 eyeFollow 时把注视平滑拉回中立再清目标：
   * 只 clearGazeTarget() 会留下上一帧的平滑值（实测 AngleY 冻在 8.4），
   * 先 gaze(0,0) 让 gazeState.cur 衰减到 0，再清目标交给待机。
   */
  function resetGazeToNeutral(settleMs) {
    var L = window.DSH_L2D;
    if (gazeNeutralTimer) {
      clearTimeout(gazeNeutralTimer);
      gazeNeutralTimer = 0;
    }
    if (L && L.gaze) {
      try { L.gaze(0, 0); } catch (e) { /* ignore */ }
    }
    gazeNeutralTimer = setTimeout(function () {
      gazeNeutralTimer = 0;
      clearGazeTarget();
    }, Math.max(200, Number(settleMs) || 800));
  }

  function applyEyeFollowSetting() {
    if (settings.eyeFollow === false) {
      if (env.away) exitAway('eyeFollow-off');
      releaseInputGaze();
      stopAwayWander();
      env.inputEl = null;
      env.inputRect = null;
      resetGazeToNeutral(800);
    } else if (env.bound) {
      if (gazeNeutralTimer) {
        clearTimeout(gazeNeutralTimer);
        gazeNeutralTimer = 0;
      }
      if (env.away) {
        startAwayWander();
      } else {
        refreshInputTarget();
        if (env.inputGazeOn) aimAtInput();
      }
    }
  }

  /** 最近一次指针位置：拖动结束/窗口变化后用它重算注视（锚点变了，旧目标会错位） */
  var lastPointer = null;

  /**
   * 眼神/躯体跟随：以「角色脸部锚点」为原点、固定像素半径归一化。
   * 锚点每次 pointermove 都重读 root 矩形，所以拖动模型后自动重锚，不会错位；
   * 参考半径 R = max(360, min(窗口宽, 高) × 0.45)，锚点到光标 1R 即满量程。
   * 死区 28px（带 28~90px 渐入）：鼠标停在角色脸上时自然正视，不会抖。
   */
  function driveGaze(e) {
    var L = window.DSH_L2D;
    if (!L || !L.gaze || !L.isReady || !L.isReady()) return;
    if (settings.eyeFollow === false) return;
    var probe = updateMouseGeometry();
    if (!probe) return;
    lastPointer = { clientX: e.clientX, clientY: e.clientY };
    var cx = probe.cx;
    var cy = probe.cy;
    var R = Math.max(360, Math.min(probe.winW || 1, probe.winH || 1) * 0.45);
    var dx = e.clientX - cx;
    var dy = e.clientY - cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var DEAD = 28;
    var RAMP = 62; // 28px ~ 90px 平滑渐入
    var nx = 0;
    var ny = 0;
    if (dist > DEAD) {
      var mag = Math.min(1, (dist - DEAD) / Math.max(1, R - DEAD));
      var ramp = Math.min(1, (dist - DEAD) / RAMP);
      nx = (dx / dist) * mag * ramp;
      ny = (dy / dist) * mag * ramp;
    }
    nx = Math.max(-1, Math.min(1, nx));
    ny = Math.max(-1, Math.min(1, ny));
    // 诊断计数器（HUD 可见）：moves 增长 = pointermove 真的送到 overlay；
    // g 是归一化后幅度（|g|>=0.25 转头、>=0.45 起身体、>=0.85 身体满）。
    try {
      probe.moves = (probe.moves || 0) + 1;
      probe.at = Date.now();
      probe.gx = Math.round(nx * 100) / 100;
      probe.gy = Math.round(-ny * 100) / 100;
      probe.rawX = Math.round(e.clientX);
      probe.rawY = Math.round(e.clientY);
    } catch (err) { /* ignore */ }
    // 输入框聚焦且可见时，注视由 aimAtInput 接管；鼠标只更新诊断计数器，不抢目标
    if (env.inputGazeOn) return;
    // 屏幕坐标 y 向下，模型 AngleY/EyeBallY 正值是「抬头」——取反
    L.gaze(nx, -ny);
  }

  /** 重锚：位置/窗口变了之后，用最后一次指针位置重算注视，避免旧目标错位 */
  function reanchorGaze() {
    if (lastPointer) driveGaze(lastPointer);
  }

  // 视线复位：只在「光标离开整个页面」或「窗口失焦」时清注视目标。
  // 离开角色身体区域不做处理——否则眼睛会随悬停边界频繁回正、观感抖动。
  function clearGazeTarget() {
    var L = window.DSH_L2D;
    if (L && L.clearGaze) {
      try { L.clearGaze(); } catch (err) { /* ignore */ }
    }
  }
  document.addEventListener('pointerleave', clearGazeTarget);
  window.addEventListener('blur', clearGazeTarget);

  // ---------------------------------------------------------------- 环境感知层
  //
  // 只做「原始交互信号」：输入框聚焦/输入 -> 注视输入框；60s 无活动 -> away；
  // 任意活动/可见性恢复 -> 回归。不调工具、不烧 LLM；全部经 eyeFollow 开关与
  // 动作门闩（currentAct）过滤，动作播放期不抢镜。
  // 原始信号通过 window.__DSH_L2D_ENV__ 与 dsh-l2d:presence / user-input / away / return
  // 事件暴露，供宿主侧人设规划层消费（本层不负责规划）。

  function envEnabled() {
    return settings.eyeFollow !== false;
  }

  /**
   * 屏幕点 -> 注视归一化。与 driveGaze 同一套口径：
   * 锚点 = 角色脸部（updateMouseGeometry 的 cx/cy，随角色移动自动重锚），
   * 参考半径 R = max(360, min(窗口宽, 高) × 0.45)，死区 28px + 62px 渐入。
   * 输入框注视走这条换算，才能和鼠标跟随保持一致的「往哪看」语义。
   */
  function screenToGaze(clientX, clientY) {
    var probe = updateMouseGeometry();
    if (!probe) return { x: 0, y: 0 };
    var R = Math.max(360, Math.min(probe.winW || 1, probe.winH || 1) * 0.45);
    var dx = clientX - probe.cx;
    var dy = clientY - probe.cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var DEAD = 28;
    var RAMP = 62;
    var nx = 0;
    var ny = 0;
    if (dist > DEAD) {
      var mag = Math.min(1, (dist - DEAD) / Math.max(1, R - DEAD));
      var ramp = Math.min(1, (dist - DEAD) / RAMP);
      nx = (dx / dist) * mag * ramp;
      ny = (dy / dist) * mag * ramp;
    }
    return { x: Math.max(-1, Math.min(1, nx)), y: Math.max(-1, Math.min(1, ny)) };
  }

  function isTextInput(el) {
    if (!el || el.nodeType !== 1 || !el.matches) return false;
    try {
      if (el.closest('#dsh-l2d-root,.l2d-panel,.l2d-menu')) return false; // 自己的面板不算聊天输入
      return el.matches(ENV_INPUT_SELECTOR);
    } catch (e) {
      return false;
    }
  }

  /** 当前聚焦的聊天输入框：textarea / input / contenteditable / role=textbox 多选择器探测 */
  function findChatInput() {
    var active = null;
    try {
      active = document.activeElement;
    } catch (e) {
      return null;
    }
    if (isTextInput(active)) return active;
    if (active && active.closest) {
      try {
        var ce = active.closest('[contenteditable="true"],[contenteditable=""],[role="textbox"]');
        if (ce && isTextInput(ce)) return ce;
      } catch (e2) { /* ignore */ }
    }
    return null;
  }

  /** 从事件目标（含 shadow DOM composedPath）向上找聊天输入框 */
  function closestTextInput(node) {
    var el = node;
    for (var i = 0; el && i < 6; i++) {
      if (isTextInput(el)) return el;
      if (el.closest) {
        try {
          var ce = el.closest('[contenteditable="true"],[contenteditable=""],[role="textbox"]');
          if (ce && isTextInput(ce)) return ce;
        } catch (e) { /* ignore */ }
      }
      el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    }
    return null;
  }

  /** 焦点是否仍在 el 内（含 shadow host 情况） */
  function focusStillIn(el) {
    var active = null;
    try { active = document.activeElement; } catch (e) { return false; }
    if (!active || !el) return false;
    if (active === el || (el.contains && el.contains(active))) return true;
    try {
      if (active.shadowRoot && active.shadowRoot.contains && active.shadowRoot.contains(el)) return true;
    } catch (e2) { /* ignore */ }
    return false;
  }

  function refreshInputTarget() {
    // 先看已记录的输入框是否仍持有焦点（shadow DOM 里 activeElement 只会是 host）
    if (env.inputEl && focusStillIn(env.inputEl)) {
      var keep = env.inputEl.getBoundingClientRect ? env.inputEl.getBoundingClientRect() : null;
      if (keep && keep.width >= 16 && keep.height >= 10) {
        env.inputRect = { left: keep.left, top: keep.top, width: keep.width, height: keep.height };
        env.inputGazeOn = true;
        return true;
      }
    }
    var el = findChatInput();
    if (!el || !el.getBoundingClientRect) {
      env.inputEl = null;
      env.inputRect = null;
      env.inputGazeOn = false;
      return false;
    }
    var r = el.getBoundingClientRect();
    if (!r || r.width < 16 || r.height < 10) {
      env.inputEl = null;
      env.inputRect = null;
      env.inputGazeOn = false;
      return false;
    }
    env.inputEl = el;
    env.inputRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    env.inputGazeOn = true;
    return true;
  }

  /** 注视输入框中心（覆盖鼠标跟随）；返回是否生效 */
  function aimAtInput() {
    var L = window.DSH_L2D;
    if (!L || !L.gaze || !envEnabled()) return false;
    if (!refreshInputTarget()) return false;
    var r = env.inputRect;
    var p = screenToGaze(r.left + r.width / 2, r.top + r.height / 2);
    try {
      L.gaze(p.x, -p.y);
    } catch (e) {
      return false;
    }
    env.lastAimAt = Date.now();
    return true;
  }

  function releaseInputGaze() {
    var had = env.inputGazeOn || !!env.inputEl;
    env.inputEl = null;
    env.inputRect = null;
    env.inputGazeOn = false;
    if (!had || !envEnabled()) return;
    // 焦点离开输入框：立刻回到鼠标驱动；没有历史指针就回正脸
    if (lastPointer) {
      driveGaze(lastPointer);
    } else {
      var L = window.DSH_L2D;
      if (L && L.gaze) {
        try { L.gaze(0, 0); } catch (e) { /* ignore */ }
      }
    }
  }

  function noteActivity(kind) {
    var now = Date.now();
    env.lastActivityAt = now;
    if (kind === 'key' || kind === 'typing') env.lastKeyAt = now;
    if (kind === 'typing') env.lastTypingAt = now;
    if (kind === 'pointer') env.lastPointerAt = now;
    if (env.away) exitAway(kind);
  }

  function computeEnvState(now) {
    if (env.away) return 'away';
    if (env.inputGazeOn || now - env.lastTypingAt < ENV_TYPING_HOLD_MS) return 'conversation';
    if (now - env.lastKeyAt < ENV_WORK_HOLD_MS) return 'work';
    return 'idle';
  }

  /** 环境层改状态：只动 class/chip（不持久化、不弹气泡，避免焦点切换刷屏） */
  function applyEnvState(next) {
    if (prefs.state === next) return;
    prefs.state = next;
    pushL2dLog({ comp: 'stage', state: next });
    // 不写 localStorage：远离/回归是瞬态，别让下次启动卡在 away；手动切换仍由 setState 持久化
    if (root) root.className = next;
    flashChipState(next); // chip 常驻为性能读数，情境名闪现 2 秒（UI4）
    env.lastStateAt = Date.now();
    postEnvPresence('state'); // conversation/work/idle 切换时上报（≥1s 节流）
  }

  function startAwayWander() {
    stopAwayWander();
    var tick = function () {
      if (!env.away || !envEnabled()) {
        env.wanderTimer = 0;
        return;
      }
      var L = window.DSH_L2D;
      if (L && L.gaze) {
        // 张望：小幅慢扫，不用动作链/表情（低成本，且不占舞台）
        try {
          L.gaze((Math.random() - 0.5) * 0.7, -0.05 + (Math.random() - 0.5) * 0.25);
        } catch (e) { /* ignore */ }
      }
      env.wanderTimer = setTimeout(tick, 5000 + Math.random() * 4000);
    };
    env.wanderTimer = setTimeout(tick, 2500);
  }

  function stopAwayWander() {
    if (env.wanderTimer) {
      clearTimeout(env.wanderTimer);
      env.wanderTimer = 0;
    }
  }

  function enterAway(reason) {
    if (env.away || !envEnabled()) return;
    env.away = true;
    env.awaySince = Date.now();
    releaseInputGaze();
    clearGazeTarget();
    applyEnvState('away');
    say(BUBBLE.away[Math.floor(Math.random() * BUBBLE.away.length)], 2400);
    startAwayWander();
    publishPresence();
    postEnvPresence('away', { reason: reason || 'idle' }, { force: true });
    dispatchEnvEvent('dsh-l2d:away', { reason: reason || 'idle' });
  }

  function exitAway(reason) {
    if (!env.away) return;
    env.away = false;
    env.lastRestoreAt = Date.now();
    stopAwayWander();
    if (!envEnabled()) {
      applyEnvState('idle');
      publishPresence();
      return;
    }
    // 回归：先看输入框（有的话），再给一个轻表情；有演出占槽时不抢
    var aimed = aimAtInput();
    var L = window.DSH_L2D;
    if (!aimed && L && L.gaze) {
      try { L.gaze(0, -0.05); } catch (e) { /* ignore */ }
    }
    var busy = L && L.currentAct ? L.currentAct() : null;
    if (!busy) agentAct('NORMAL', 'return', [{ kind: 'expression', name: '兔牙' }]);
    say('我回来啦', 2200);
    // 按回归瞬间的实际状态落：焦点还在输入框就是 conversation，刚敲键盘就是 work
    applyEnvState(computeEnvState(Date.now()));
    publishPresence();
    postEnvPresence('return', { reason: reason || 'activity' }, { force: true });
    dispatchEnvEvent('dsh-l2d:return', { reason: reason || 'activity' });
  }

  function dispatchEnvEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (e) { /* ignore */ }
  }

  function publishUserInput(el) {
    var now = Date.now();
    if (now - env.lastInputEventAt < 200) return;
    env.lastInputEventAt = now;
    var len = 0;
    try {
      len = el && typeof el.value === 'string' ? el.value.length : (el && el.textContent ? el.textContent.length : 0);
    } catch (e) { /* ignore */ }
    dispatchEnvEvent('dsh-l2d:user-input', { length: len });
    postEnvPresence('user-input', { inputLength: len }); // ≥200ms 节流，只上报长度
  }

  function publishPresence() {
    var now = Date.now();
    var snap = {
      state: prefs.state,
      away: env.away,
      idleMs: now - env.lastActivityAt,
      hidden: document.hidden === true,
      inputFocused: !!env.inputGazeOn,
      inputRect: env.inputRect
        ? {
            left: Math.round(env.inputRect.left),
            top: Math.round(env.inputRect.top),
            width: Math.round(env.inputRect.width),
            height: Math.round(env.inputRect.height)
          }
        : null,
      lastKeyAt: env.lastKeyAt,
      lastTypingAt: env.lastTypingAt,
      updatedAt: now
    };
    window.__DSH_L2D_ENV__ = snap;
    if (now - env.publishAt >= 1000) {
      env.publishAt = now;
      dispatchEnvEvent('dsh-l2d:presence', snap);
    }
  }

  /** 环境事件 → 宿主反向桥；失败静默（宿主未开反向桥或白名单未更新都不影响本地表现） */
  function envPresencePayload(kind, extra) {
    var now = Date.now();
    var payload = {
      kind: kind || 'presence',
      state: String(prefs.state || 'idle'),
      away: !!env.away,
      idleMs: Math.max(0, now - env.lastActivityAt),
      hidden: document.hidden === true,
      inputFocused: !!env.inputGazeOn,
      lastTypingAt: env.lastTypingAt || 0,
      at: now
    };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
      }
    }
    return payload;
  }

  function postEnvPresence(kind, extra, options) {
    var now = Date.now();
    var force = !!(options && options.force);
    var isInput = kind === 'user-input';
    var lastAt = isInput ? env.lastInputPostAt : env.lastPresencePostAt;
    var minGap = isInput ? ENV_INPUT_MIN_MS : ENV_PRESENCE_MIN_MS;
    if (!force && now - lastAt < minGap) {
      // 被节流的状态变化留一份最新快照，下一次 tick 补发，避免切换事件被吞掉。
      // 心跳不排队：hidden 期间不应有延迟心跳，下一轮 10s 到点自然会补。
      if (!isInput && kind === 'state') env.pendingPresence = { kind: kind, extra: extra || null };
      return false;
    }
    if (force) env.pendingPresence = null;
    if (isInput) env.lastInputPostAt = now;
    else env.lastPresencePostAt = now;
    try {
      fetch(ENV_REVERSE_EVENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'presence', payload: envPresencePayload(kind, extra) })
      }).catch(function () { /* 静默：宿主侧可能还没把 presence 加进白名单 */ });
    } catch (e) { /* ignore */ }
    return true;
  }

  function presenceTick() {
    var now = Date.now();
    if (envEnabled()) {
      // 每秒同步一次焦点：覆盖 focus 事件丢失、输入框重建、布局漂移。
      // 离席期间不追输入框，否则会一直盯着输入框、away 就形同虚设。
      if (!env.away) {
        refreshInputTarget();
        if (env.inputGazeOn && now - env.lastAimAt > 600) aimAtInput();
      }
      var idleMs = now - env.lastActivityAt;
      if (!env.away && idleMs >= ENV_AWAY_AFTER_MS) enterAway('idle');
      if (env.away && idleMs < ENV_AWAY_AFTER_MS) exitAway('active');
      if (now >= env.manualUntil) applyEnvState(computeEnvState(now));
      // 被节流掉的状态变化补发（仍然 ≥1s 一次）
      if (env.pendingPresence && now - env.lastPresencePostAt >= ENV_PRESENCE_MIN_MS) {
        var pending = env.pendingPresence;
        env.pendingPresence = null;
        postEnvPresence(pending.kind, pending.extra);
      }
      // 心跳只在页面可见时发；hidden 时停，恢复可见后由活动/状态事件补
      if (!document.hidden && now - env.lastHeartbeatAt >= ENV_HEARTBEAT_MS && postEnvPresence('heartbeat')) {
        env.lastHeartbeatAt = now;
      }
    }
    publishPresence();
  }

  function initEnvironmentSensors() {
    if (env.bound) return;
    env.bound = true;
    window.addEventListener('pointermove', function () { noteActivity('pointer'); }, { passive: true, capture: true });
    window.addEventListener('pointerdown', function () { noteActivity('pointer'); }, { passive: true, capture: true });
    window.addEventListener('wheel', function () { noteActivity('pointer'); }, { passive: true, capture: true });
    document.addEventListener(
      'keydown',
      function () {
        noteActivity('key');
        if (findChatInput()) noteActivity('typing');
      },
      true
    );
    document.addEventListener(
      'focusin',
      function (e) {
        var path = e.composedPath && e.composedPath();
        var target = path && path.length ? path[0] : e.target;
        var el = closestTextInput(target) || findChatInput();
        if (!el) return;
        env.inputFocusedAt = Date.now();
        noteActivity('typing');
        refreshInputTarget();
        aimAtInput();
      },
      true
    );
    document.addEventListener(
      'focusout',
      function () {
        // 焦点可能在输入框内部节点间移动，下一拍再判断
        setTimeout(function () {
          if (findChatInput()) {
            refreshInputTarget();
            aimAtInput();
          } else {
            releaseInputGaze();
          }
        }, 0);
      },
      true
    );
    document.addEventListener(
      'input',
      function (e) {
        var path = e.composedPath && e.composedPath();
        var target = path && path.length ? path[0] : e.target;
        var el = closestTextInput(target) || findChatInput();
        if (!el) return;
        noteActivity('typing');
        refreshInputTarget();
        aimAtInput();
        publishUserInput(el);
      },
      true
    );
    document.addEventListener(
      'visibilitychange',
      function () {
        if (document.hidden) {
          env.hiddenAt = Date.now();
        } else {
          env.hiddenAt = 0;
          noteActivity('visible');
          if (env.away) exitAway('visible');
          if (env.inputGazeOn) aimAtInput();
        }
      },
      true
    );
    window.addEventListener('focus', function () { noteActivity('focus'); }, { passive: true });
    env.tickTimer = setInterval(presenceTick, ENV_TICK_MS);
    publishPresence();
    postEnvPresence('init', null, { force: true }); // 初始快照，宿主不用等第一个心跳
  }

  function initEmotionSensors() {
    var L = window.DSH_L2D;
    // 气泡回调：router 的 bubble 意图由 say() 上屏
    if (L && L.setEmotionBubble) L.setEmotionBubble(say);

    if (!emotionSensors.mouseBound) {
      emotionSensors.mouseBound = true;
      var lastX = null;
      var lastY = null;
      var lastT = 0;
      var pushT = 0;
      window.addEventListener(
        'pointermove',
        function (e) {
          var now = Date.now();
          var dt = lastT ? now - lastT : 0;
          if (lastX !== null && dt > 0) {
            emotionSensors.vx = ((e.clientX - lastX) / dt) * 1000;
            emotionSensors.vy = ((e.clientY - lastY) / dt) * 1000;
          }
          lastX = e.clientX;
          lastY = e.clientY;
          lastT = now;
          driveGaze(e); // 注视要跟手，节流放到渲染端平滑（桌宠模式下保留眼神跟随）
          feedHitProbe(e); // 命中探针（供 alpha 采样），悬停时也刷新
          if (now - pushT < 250) return;
          pushT = now;
          if (settings.petMode === true) return; // 桌宠模式：停发鼠标情绪信号（速度/连点类规则随之失效）
          emotionPush({
            type: 'mouse',
            data: { x: e.clientX, y: e.clientY, vx: emotionSensors.vx || 0, vy: emotionSensors.vy || 0 },
          });
        },
        { passive: true }
      );
      window.addEventListener(
        'pointerdown',
        function () {
          if (settings.petMode === true) return; // 桌宠模式：点击信号不发（click-hyper 规则随之失效）
          emotionPush({ type: 'mouse', data: { click: true } });
        },
        { passive: true }
      );
      // 窗口尺寸/角色位置变了，HUD 的几何诊断跟着更新（没有鼠标移动时也能看）
      window.addEventListener('resize', updateMouseGeometry, { passive: true });
    }
    updateMouseGeometry();
    applyEyeFollowSetting();
    syncSystemSensor();
    syncMediaSensor();
  }

  // 媒体律动（默认关）：检测页面内 <video>/<audio> 播放状态，
  // 播放中让模型随节拍轻摆。说明：DSH 插件环境拿不到系统级音频/媒体进程，
  // 这里降级为「页面内媒体元素」侦测；系统级留待原生模块。
  var mediaSensorState = { bound: false, timer: 0 };

  function anyMediaPlaying() {
    var nodes = document.querySelectorAll('video, audio');
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].paused && !nodes[i].muted) return true;
    }
    return false;
  }

  function syncMediaSway() {
    var L = window.DSH_L2D;
    if (L && L.setMediaSway) {
      try {
        L.setMediaSway(anyMediaPlaying());
      } catch (e) {
        /* ignore */
      }
    }
  }

  function syncMediaSensor() {
    var want = settings.mediaSensor === true;
    if (!want) {
      if (mediaSensorState.timer) {
        clearInterval(mediaSensorState.timer);
        mediaSensorState.timer = 0;
        document.removeEventListener('play', syncMediaSway, true);
        document.removeEventListener('pause', syncMediaSway, true);
        var L = window.DSH_L2D;
        if (L && L.setMediaSway) L.setMediaSway(false);
      }
      return;
    }
    if (mediaSensorState.timer) return;
    document.addEventListener('play', syncMediaSway, true);
    document.addEventListener('pause', syncMediaSway, true);
    // 兜底轮询：媒体元素可能在监听挂上之前就开始播了
    mediaSensorState.timer = setInterval(syncMediaSway, 4000);
    syncMediaSway();
  }

  /** 系统传感器开关（默认关）：5s 轮询 CPU/内存 + 电量/断网监听 */
  function syncSystemSensor() {
    var want = settings.systemSensor === true;
    if (!want) {
      emotionSensors.sysGen++; // 作废所有在飞的采样响应
      if (emotionSensors.sysTimer) {
        clearInterval(emotionSensors.sysTimer);
        emotionSensors.sysTimer = 0;
        window.removeEventListener('online', onNetChange);
        window.removeEventListener('offline', onNetChange);
      }
      unbindBattery(); // 关闭系统联动时解绑电池事件，避免继续往 Emotion_Router 送旧数据
      return;
    }
    if (emotionSensors.sysTimer) return;
    var gen = ++emotionSensors.sysGen;
    emotionSensors.sysTimer = setInterval(function () {
      fetch('/dsh-l2d/sys-metrics.json', { cache: 'no-store' })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (d) {
          if (gen !== emotionSensors.sysGen) return; // 已关闭/重启：丢弃过期响应
          if (!d || !d.ok) return;
          emotionPush({
            type: 'system',
            data: {
              cpu: typeof d.cpu === 'number' ? d.cpu : undefined,
              mem: typeof d.mem === 'number' ? d.mem : undefined,
              online: typeof navigator.onLine === 'boolean' ? navigator.onLine : true,
            },
          });
        })
        .catch(function () {
          /* 下一轮再试 */
        });
    }, 5000);
    window.addEventListener('online', onNetChange);
    window.addEventListener('offline', onNetChange);
    bindBattery();
  }

  function onNetChange() {
    emotionPush({ type: 'system', data: { online: navigator.onLine } });
  }

  function bindBattery() {
    if (emotionSensors.batteryBound || !navigator.getBattery) return;
    emotionSensors.batteryBound = true;
    navigator
      .getBattery()
      .then(function (bat) {
        var push = function () {
          emotionPush({ type: 'system', data: { battery: bat.level, charging: bat.charging } });
        };
        push();
        bat.addEventListener('levelchange', push);
        bat.addEventListener('chargingchange', push);
        // 记下引用：关闭系统联动时要能解绑，否则监听会继续把旧信号送进 Emotion_Router
        emotionSensors.batteryInstance = bat;
        emotionSensors.batteryPush = push;
      })
      .catch(function () {
        /* 无电池设备忽略 */
      });
  }

  /** 解绑电池监听（系统联动关闭时调用；重开时 bindBattery 会重新绑定） */
  function unbindBattery() {
    var bat = emotionSensors.batteryInstance;
    var push = emotionSensors.batteryPush;
    if (bat && push) {
      try {
        bat.removeEventListener('levelchange', push);
        bat.removeEventListener('chargingchange', push);
      } catch (e) { /* ignore */ }
    }
    emotionSensors.batteryInstance = null;
    emotionSensors.batteryPush = null;
    emotionSensors.batteryBound = false; // 允许重新开启时再次绑定
  }

  // ---------------------------------------------------------------- AI 指令轮询
  //
  // 宿主侧 /dsh-l2d/ai/call 收到的指令入队，这里每 400ms 取一次并执行。
  // 用轮询而不是长连接：插件环境没有稳定的 WebSocket，轮询失败可以自愈。
  var aiPollTimer = 0;
  // /ai/poll 搭车下发的反向桥快照（模型→宿主事件最近记录），供 l2d_get_state 查询
  var aiReverseState = null;
  // 消费者租约（M1-d3）：租约被他人持有时跳过的 tick 数（4×400ms≈1.6s，降频等接管）
  var aiPollHoldTicks = 0;

  // result 提交统一走这里：附带 poll 时下发的租约凭证（flag 关时服务端忽略）。
  // 409 fenced 不重试——重试必然再被 fence，仅告警留痕。
  var AI_EXEC_DEADLINE_MS = 8000;

  function postAiResult(payload, attempt) {
    payload.token = __aiLeaseToken;
    payload.epoch = __aiLeaseEpoch;
    attempt = attempt || 0;
    return fetch('/dsh-l2d/ai/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (!r.ok) {
        console.warn('[dsh-l2d] AI 回执被拒 id=' + payload.id + ' status=' + r.status);
        // 409 fenced 不重试——重试必然再被 fence。其它失败（网络闪断）再试两次。
        if (r.status !== 409 && attempt < 2) {
          return new Promise(function (resolve) { setTimeout(resolve, 150 * (attempt + 1)); })
            .then(function () { return postAiResult(payload, attempt + 1); });
        }
      }
      return r;
    }).catch(function (err) {
      if (attempt < 2) {
        return new Promise(function (resolve) { setTimeout(resolve, 150 * (attempt + 1)); })
          .then(function () { return postAiResult(payload, attempt + 1); });
      }
      throw err;
    });
  }

  function execWithDeadline(name, args, callId) {
    var settled = false;
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: 'timeout', tool: name, message: '执行超过 ' + AI_EXEC_DEADLINE_MS + 'ms 仍未返回' });
      }, AI_EXEC_DEADLINE_MS);
      Promise.resolve(window.DSH_L2D_AI.exec(name, args, callId)).then(function (res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      }, function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: String(err && err.message ? err.message : err) });
      });
    });
  }

  function startAiPoll() {
    if (aiPollTimer) return;
    aiPollTimer = setInterval(function () {
      if (aiPollHoldTicks > 0) { aiPollHoldTicks--; return; } // 租约被他人持有：降频轮询
      if (!window.DSH_L2D_AI) return;
      // 后台标签页被浏览器节流/冻结时若仍来 splice 队列，设置页预览会等到超时，前台角色也不变。
      var hidden = typeof document !== 'undefined' && document.hidden;
      fetch('/dsh-l2d/ai/poll?consumer=' + encodeURIComponent(__aiConsumerId) + '&version=' + encodeURIComponent(__bootTag || '') + '&hidden=' + (hidden ? '1' : '0'), { cache: 'no-store' })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (d) {
          // 先消费搭车的反向桥快照（必须在无指令提前 return 之前，否则没指令时永远不更新）
          if (d && d.reverse) aiReverseState = d.reverse;
          if (d && d.lease) {
            if (d.lease.token) {
              __aiLeaseToken = d.lease.token; // 接管/续期发放的新凭证（含接管后 token 轮换）
              __aiLeaseEpoch = d.lease.epoch || 0;
            } else if (d.lease.status === 'held') {
              aiPollHoldTicks = 4; // 他人持租约：拉长下次 poll 间隔
            }
          }
          if (!d || !d.calls || !d.calls.length) return;
          d.calls.forEach(function (c) {
            execWithDeadline(c.name, c.args, c.id)
              .then(function (res) {
                if (!res || res.ok === false) {
                  // skipped / conflict 是状态机的正常结果，不当成异常刷屏
                  if (!res || (res.reason !== 'skipped' && res.reason !== 'conflict' && res.status !== 'skipped' && res.status !== 'conflict')) {
                    console.warn('[dsh-l2d] AI 指令执行失败', c.name, res);
                  }
                }
                return postAiResult({ id: c.id, result: res || { ok: false, reason: 'empty' } });
              })
              .catch(function (err) {
                return postAiResult({ id: c.id, result: { ok: false, reason: String(err && err.message ? err.message : err) } });
              })
              .catch(function () { /* 结果回写失败，MCP 会超时 */ });
          });
        })
        .catch(function () {
          /* 宿主未就绪，下一轮再试 */
        });
    }, 400);
  }

  // ---------------------------------------------------------------- AI 控制桥
  //
  // 给宿主侧 / 外部 Agent 的统一入口：把 function-calling 的工具名映射到渲染包能力。
  // 设计要点：
  //   - 一律返回结构化结果，失败不抛异常（AI 侧要能根据 ok/error 自行重试）
  //   - 参数逐个校验，setParameters 会把不存在的参数名列进 failed
  window.DSH_L2D_AI = {
    version: 1,

    /** 执行一次工具调用。callId 是 /ai/call 的队列号，动作链回执靠它写回 /ai/result。 */
    exec: function (name, args, callId) {
      var a = args || {};
      pushL2dLog({ comp: 'ai', action: String(name || ''), state: 'exec' });
      var L = window.DSH_L2D;
      if (!L) return { ok: false, error: 'renderer-not-ready' };

      if (L.markActive) L.markActive();
      try {
        switch (name) {
          case 'l2d_set_expression': {
            var okExp = L.setExpression(String(a.name || ''));
            return okExp ? { ok: true } : { ok: false, error: 'unknown-expression: ' + a.name };
          }
          case 'l2d_play_motion': {
            if (!L.playMotionAsync) return { ok: false, reason: 'motion-unavailable' };
            var motionGroup = String(a.group || '');
            var motionOpts = {
              index: Number(a.index || 0),
              awaitFinish: a.awaitFinish === true,
            };
            return Promise.resolve(playMotionYieldingSharedArm(L, motionGroup, motionOpts)).then(function (r) {
              if (!r) return { ok: false, reason: 'empty' };
              var yielded = Array.isArray(r.yieldedCloses) ? r.yieldedCloses : [];
              if (r.status === 'ok') {
                return { ok: true, status: r.status, group: r.group, slot: r.slot, dir: r.dir, yieldedCloses: yielded };
              }
              return { ok: false, reason: r.reason || r.status, status: r.status, group: r.group, yieldedCloses: yielded };
            });
          }
          case 'l2d_emote': {
            var moodName = String(a.mood || a.name || '').trim();
            if (!moodName) return { ok: false, reason: 'empty-mood' };
            if (L.emotionSignal) L.emotionSignal({ type: 'mood', data: { mood: moodName } });
            return { ok: true, mood: moodName };
          }
          case 'l2d_facial': {
            // FI PR-01：FacialPlan 透传渲染层 applyFacialIntent（Schema 验证/仲裁/平滑全在桥内）。
            // 验证失败拒绝并回 errors，不写入任何参数。
            if (!L.applyFacialIntent) return { ok: false, reason: 'facial-unavailable' };
            var planBody = a.plan !== undefined ? a.plan : a;
            var fr = L.applyFacialIntent(planBody);
            return { ok: !!fr.ok, errors: fr.errors || [], warnings: fr.warnings || [] };
          }
          case 'l2d_facial_manual': {
            // FI PR-01 手动覆盖：MANUAL=900，不被 LLM 盖；释放用 l2d_facial_manual {release:true}
            if (!L.setManualFacialParam) return { ok: false, reason: 'facial-unavailable' };
            if (a.release) {
              L.releaseManualFacial ? L.releaseManualFacial() : null;
              return { ok: true, released: true };
            }
            var okM = L.setManualFacialParam(String(a.semantic || ''), Number(a.value));
            return { ok: !!okM };
          }
          case 'l2d_gaze': {
            var gx = Math.max(-1, Math.min(1, Number(a.x) || 0));
            var gy = Math.max(-1, Math.min(1, Number(a.y) || 0));
            if (L.gaze) L.gaze(gx, gy);
            else L.lookAt(gx, gy);
            return { ok: true, x: gx, y: gy };
          }
          case 'l2d_say': {
            var said = String(a.text || '').slice(0, 200);
            if (!said) return { ok: false, reason: 'empty-text' };
            var hold = Math.max(800, Math.min(12000, Number(a.holdMs) || 3600));
            say(said, hold);
            return { ok: true };
          }
          case 'l2d_act': {
            var actChain = Array.isArray(a.chain) ? a.chain : [];
            if (!actChain.length && !a.phase) return { ok: false, accepted: false, reason: 'empty-chain' };
            return executePokeAction({
              chain: actChain,
              phase: a.phase,
              bubble: a.bubble || '',
              silent: !a.bubble,
              priority: a.priority,
              callId: callId,
              source: a.phase ? String(a.phase) : 'ai',
            });
          }
          case 'l2d_get_state': {
            return {
              ok: true,
              ready: !!(L.isReady && L.isReady()),
              // 自检：计划层能力 + 注入版本，用来区分「页面跑旧脚本」与「逻辑真没生效」。
              diag: {
                bootTag: __bootTag || '',
                hasPlan: typeof L.normalizeActPlan,
                hasNote: typeof L.noteActMotion,
                // [M1-d2 诊断] armed/timeline 活体状态（临时诊断，随 d2 验收移除或保留为观测面）
                gesture: L.getGestureState ? L.getGestureState() : 'getGestureState-missing',
                // [M1-f 第二批] cue 账本活体状态（enabled/active channels/overlay），与 gesture 并列
                cue: L.getCueState ? L.getCueState() : 'missing',
                rendererEl: (document.getElementById('dsh-l2d-renderer') || {}).src || '',
                winHasPlan: (typeof window !== 'undefined' && window.DSH_L2D) ? typeof window.DSH_L2D.normalizeActPlan : 'no-win-api',
                sameRef: !!(typeof window !== 'undefined' && window.DSH_L2D === L),
                planKeys: (typeof window !== 'undefined' && window.DSH_L2D) ? Object.keys(window.DSH_L2D).filter(function (k) { return /plan|normal/i.test(k); }).join(',') : '',
                scripts: Array.prototype.map.call(document.querySelectorAll('script[src*="dsh-l2d/renderer"]'), function (x) { return x.src; }).join(' | '),
                guarded: !!window.__DSH_L2D_GUARD__,
                keyCount: Object.keys(window.DSH_L2D || {}).length,
                clientEntry: (typeof window !== 'undefined')
                  ? (window.__L2D_CLIENT_ERROR__ ? 'ERR: ' + String(window.__L2D_CLIENT_ERROR__).slice(0, 4000)
                    : window.__L2D_CLIENT_OK__ ? 'ok'
                    : 'not-run')
                  : 'no-window',
                keys: Object.keys(window.DSH_L2D || {}).join(','),
              },
              info: L.getInfo ? L.getInfo() : null,
              emotion: L.getEmotionState ? L.getEmotionState() : null,
              pose: L.getPose ? L.getPose() : null,
              reverse: aiReverseState,
            };
          }
          case 'l2d_reset': {
            if (L.resetPerformance) return L.resetPerformance();
            var n = L.resetPose ? L.resetPose() : 0;
            if (L.clearExpression) L.clearExpression();
            if (L.clearGaze) L.clearGaze();
            return { ok: true, params: n };
          }
          case 'l2d_set_pose': {
            if (!L.setPose) return { ok: false, error: 'pose-unavailable' };
            var poseRes = L.setPose({
              right: a.right ? String(a.right) : undefined,
              left: a.left ? String(a.left) : undefined,
            });
            return poseRes.ok
              ? { ok: true, pose: poseRes.pose }
              : { ok: false, error: poseRes.reason || 'pose-failed' };
          }
          case 'l2d_look_at': {
            var x = Math.max(-1, Math.min(1, Number(a.x) || 0));
            var y = Math.max(-1, Math.min(1, Number(a.y) || 0));
            L.lookAt(x, y);
            return { ok: true, x: x, y: y };
          }
          case 'l2d_set_parameters': {
            var values = a.values || {};
            var keys = Object.keys(values);
            // 可选独占：写物理输出前先向渲染包认领，到期自动释放回物理。
            // durationMs 语义：有限数字（含 0/负数）原样传给渲染包；缺省 1200。
            var requested = Number(a.durationMs);
            var durationMs = Number.isFinite(requested) ? requested : 1200;
            var owned = [];
            if (a.own === true && L.ownParameters) {
              owned = L.ownParameters(keys, durationMs);
            }
            var r = L.setParameters(values);
            // 全部写入失败（口型/未知参数）时回滚本次认领，避免独占残留到 TTL
            if (owned.length && !r.ok.length && r.failed.length && L.releaseParameters) {
              L.releaseParameters(owned);
              owned = [];
            }
            // ignored：未登记独占、但按普通 add/set 写入成功的参数（非物理输出）
            var ignored = r.ok.filter(function (id) { return owned.indexOf(id) < 0; });
            return { ok: r.failed.length === 0, applied: r.ok, failed: r.failed, owned: owned, ignored: ignored, durationMs: durationMs };
          }
          case 'l2d_play_keyframes': {
            // AI 自编动作：tracks = [{ param, keys: [[t_ms, value], ...] }]
            // [M1-d2] 主闸：flag 开先手势准入再播放；被拒短路返回，不再触达 playKeyframes。
            // renderer 缺 admitGesture 或 flag 关（flagEnabled:false）→ 等价直通原路径。
            var tracks = Array.isArray(a.tracks) ? a.tracks : [];
            var ga = null;
            if (L.admitGesture) {
              var kDur = a.loop === true
                ? 0
                : Math.max(16, Math.min(10000, Number(a.duration) || gestureTracksMaxT(tracks)));
              var ga2 = L.admitGesture(gestureSegmentsFromTracks(tracks, kDur), { priority: a.priority });
              if (gestureBlocked(ga2)) {
                return {
                  ok: false,
                  accepted: false,
                  reason: 'gesture-priority-blocked',
                  rejected: ga2.rejected,
                  arbitration: arbReceipt(ga2),
                };
              }
              ga = ga2;
            }
            var n = L.playKeyframes(tracks, { duration: a.duration, loop: a.loop === true });
            if (n <= 0) return { ok: false, error: 'no-valid-tracks', arbitration: arbReceipt(ga) };
            // keyframes 播放时按轨道时长自动认领物理输出（loop 会续期），回执列出被覆盖的参数
            var kfOwned = L.getKeyframeOwnedParameters ? L.getKeyframeOwnedParameters() : [];
            return { ok: true, tracks: n, owned: kfOwned, arbitration: arbReceipt(ga) };
          }
          case 'l2d_cue': {
            // [M1-f 第二批] 结构化 cue 入口：编译/准入/账本全部在 renderer（admitCue），
            // overlay 只做入参形状校验与回执组装（字段只增不改）。
            var cueIn = (a.cue && typeof a.cue === 'object' && !Array.isArray(a.cue)) ? a.cue : null;
            if (!cueIn) return { ok: false, reason: 'empty-cue' };
            if (!L.admitCue) return { ok: false, reason: 'not-supported' };
            var cueAdm = L.admitCue(cueIn, { runId: a.runId != null ? String(a.runId) : undefined });
            // flag 关（embodied.cue/timeline 任一关闭）→ 明确回执，不静默成功。
            if (cueAdm && cueAdm.accepted === false && cueAdm.flagEnabled === false) {
              return { ok: false, reason: 'cue-disabled', cue: cueIn, admission: cueAdm };
            }
            var cueRejected = cueAdm && Array.isArray(cueAdm.rejected) ? cueAdm.rejected : [];
            var cueOk = !!(cueAdm && cueAdm.accepted);
            var cueRec = {
              ok: cueOk,
              cue: cueIn,
              admission: cueAdm,
              arbitration: {
                admitted: cueOk,
                rejected: cueRejected,
                entryId: cueAdm ? cueAdm.entryId : undefined,
                cueId: cueIn.channel ? 'cue:' + String(cueIn.channel) : undefined,
              },
            };
            if (!cueOk) cueRec.reason = cueRejected[0] ? cueRejected[0].reason : 'cue-rejected';
            return cueRec;
          }
          case 'l2d_cue_stop': {
            // [M1-f 第二批] 显式释放 cue：selector {channel?, target?, all?} →
            // core CueReleaseSelector {channel?, overlay?, runId?}（target 对应 overlay）。
            if (!L.stopCue) return { ok: false, reason: 'not-supported' };
            var cueState = L.getCueState ? L.getCueState() : null;
            if (cueState && cueState.enabled === false) return { ok: false, reason: 'cue-disabled' };
            var selIn = (a.selector && typeof a.selector === 'object' && !Array.isArray(a.selector)) ? a.selector : null;
            var selCore;
            if (!selIn || selIn.all === true) {
              selCore = undefined;
            } else {
              selCore = {};
              if (selIn.channel != null) selCore.channel = String(selIn.channel);
              if (selIn.target != null) selCore.overlay = String(selIn.target);
              if (selIn.runId != null) selCore.runId = String(selIn.runId);
              if (selCore.channel === undefined && selCore.overlay === undefined && selCore.runId === undefined) {
                selCore = undefined;
              }
            }
            var cueStopped = L.stopCue(selCore);
            return { ok: true, selector: selIn || null, stopped: cueStopped };
          }
          case 'l2d_stop_keyframes': {
            L.stopKeyframes();
            // [M1-d2] Timeline 同步清账：armed/段与 kf 状态一致（老包无 stopGesture 时跳过）。
            if (L.stopGesture) L.stopGesture();
            return { ok: true };
          }
          case 'l2d_reset_pose': {
            var n = L.resetPose();
            return { ok: true, params: n };
          }
          case 'l2d_change_form': {
            // 形态切换复用 UI 既有入口。setBodyType 内部在缺 L.setParameter 时会静默返回，
            // 故先判定可用性，再用切换前后 index 是否变化确认真的生效（被钳制时算失败）。
            if (typeof L.setParameter !== 'function' || typeof cycleBodyType !== 'function') {
              return { ok: false, reason: 'form-unavailable' };
            }
            var formBefore = Math.max(0, Math.min(2, Number(prefs.bodyType) || 0));
            try {
              cycleBodyType();
            } catch (err) {
              return { ok: false, reason: 'form-unavailable' };
            }
            var formAfter = Math.max(0, Math.min(2, Number(prefs.bodyType) || 0));
            if (formAfter === formBefore) return { ok: false, reason: 'form-unavailable' };
            var formItem = BODY_TYPES[formAfter] || BODY_TYPES[0];
            return { ok: true, form: { index: formAfter, label: formItem.label } };
          }
          case 'l2d_set_form': {
            // 形态直达：一次切到指定 index（0..2），支持从高形态切回低形态。
            // l2d_change_form 只会 +1（钳制 0..2），无法回退；本指令补上回退通道。
            // index 必须是 0..2 的整数，不做钳制，越界/缺失/非整数一律拒绝，不猜调用方意图。
            var setIdx = a.index;
            if (typeof setIdx !== 'number' || !Number.isInteger(setIdx) || setIdx < 0 || setIdx > 2) {
              return { ok: false, reason: 'invalid-form-index' };
            }
            // setBodyType 缺 L.setParameter 时会静默返回，先判可用性，避免假成功。
            if (typeof L.setParameter !== 'function' || typeof setBodyType !== 'function') {
              return { ok: false, reason: 'form-unavailable' };
            }
            var setBefore = Math.max(0, Math.min(2, Number(prefs.bodyType) || 0));
            if (setBefore === setIdx) {
              // 已是目标形态：不重写参数、不弹气泡，回执带 already-current 便于调用方区分。
              var curItem = BODY_TYPES[setIdx] || BODY_TYPES[0];
              return { ok: true, form: { index: setIdx, label: curItem.label }, notes: ['already-current'] };
            }
            try {
              setBodyType(setIdx);
            } catch (err) {
              // setBodyType 已先写 prefs 再写 Clothes2。写入抛错时回滚记录再落盘，
              // 否则回执是失败，下次同目标会被误判成 already-current。
              prefs.bodyType = setBefore;
              persist();
              return { ok: false, reason: 'form-unavailable' };
            }
            // 以 prefs.bodyType 实际值复核，未到目标即判失败（不以"调用过"当成功）。
            var setAfter = Math.max(0, Math.min(2, Number(prefs.bodyType) || 0));
            if (setAfter !== setIdx) {
              prefs.bodyType = setBefore;
              persist();
              return { ok: false, reason: 'form-unavailable' };
            }
            var setItem = BODY_TYPES[setAfter] || BODY_TYPES[0];
            return { ok: true, form: { index: setAfter, label: setItem.label } };
          }
          default:
          case 'l2d_posture': {

            // E2：语义姿态执行。参数 id 全部来自能力画像，overlay 不写死任何模型参数。
            if (!L.planPostureExecution || !L.setParameters) return { ok: false, reason: 'posture-unavailable' };
            var pProfile = window.__L2D_PROFILE__ || null;
            if (!pProfile) return { ok: false, reason: 'profile-loading' };
            var pExec = L.planPostureExecution(pProfile, { values: a.values || {}, durationMs: a.durationMs, own: a.own, fadeMs: a.fadeMs });
            if (!pExec || !pExec.plan) return { ok: false, reason: 'profile-unavailable' };
            if (!pExec.plan.writes.length) {
              return { ok: true, applied: [], failed: [], owned: [], skipped: pExec.skipped, degraded: pExec.degraded, durationMs: pExec.input.durationMs };
            }
            var pDuration = pExec.input.durationMs;
            // M1-d1：own 必须按相位分组登记（批量、不逐参数循环）——Hip 类 pre-only 参数
            // 走 ownParameters(ids, d, 'pre') 让 PhysicsGate 让位，其余仍走缺省 post。
            // 极端情况下同参数同时出现在两相位写入时按 pre 优先去重（保证同参数只有一条登记路径）。
            var pPreOwns = [], pPostOwns = [];
            pExec.pre.forEach(function (w) {
              w.params.forEach(function (p) {
                if (pExec.owns.indexOf(p.id) >= 0 && pPreOwns.indexOf(p.id) < 0 && pPostOwns.indexOf(p.id) < 0) pPreOwns.push(p.id);
              });
            });
            pExec.post.forEach(function (w) {
              w.params.forEach(function (p) {
                if (pExec.owns.indexOf(p.id) >= 0 && pPostOwns.indexOf(p.id) < 0 && pPreOwns.indexOf(p.id) < 0) pPostOwns.push(p.id);
              });
            });
            var pOwned = [];
            if (L.ownParameters) {
              if (pPreOwns.length) pOwned = pOwned.concat(L.ownParameters(pPreOwns, pDuration, 'pre'));
              if (pPostOwns.length) pOwned = pOwned.concat(L.ownParameters(pPostOwns, pDuration, 'post'));
            }
            var pApplied = [], pFailed = [];
            var pBatch = function (writes) {
              var batch = {};
              writes.forEach(function (w) { w.params.forEach(function (p) { batch[p.id] = p.value; }); });
              if (!Object.keys(batch).length) return;
              var rr = L.setParameters(batch);
              pApplied.push.apply(pApplied, rr.ok || []);
              (rr.failed || []).forEach(function (f) {
                // setParameters 的失败格式是 '参数名:原因' 字符串
                var parts = String(f).split(':');
                pFailed.push({ id: parts[0], reason: parts[1] || 'write-failed' });
              });
            };
            pBatch(pExec.pre);
            pBatch(pExec.post);
            if (pOwned.length && !pApplied.length && L.releaseParameters) { L.releaseParameters(pOwned); pOwned = []; }
            return { ok: pFailed.length === 0, applied: pApplied, failed: pFailed, owned: pOwned, skipped: pExec.skipped, degraded: pExec.degraded, durationMs: pDuration };
          }
            return { ok: false, error: 'unknown-tool: ' + name };
        }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    },

    /** 运行时能力自省，供宿主侧生成工具清单 */
    capabilities: function () {
      var L = window.DSH_L2D;
      return L && L.getCapabilities ? L.getCapabilities() : null;
    },
  };

})();
