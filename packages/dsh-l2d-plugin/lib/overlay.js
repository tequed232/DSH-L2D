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
    'border-radius:46% 46% 42% 42%;',
    'background:linear-gradient(160deg,var(--dsh-accent),var(--dsh-accent-muted));',
    'box-shadow:var(--dsh-shadow-2);}',
    '#' + ROOT_ID + ' .l2d-chip{position:absolute;left:50%;bottom:auto;transform:translateX(-50%);',
    'top:calc(-1 * var(--dsh-control-sm) - var(--dsh-space-1));',
    'pointer-events:auto;cursor:pointer;padding:var(--dsh-space-1) var(--dsh-space-3);border-radius:var(--dsh-radius-full);',
    'font:var(--dsh-text-xs);font-weight:500;white-space:nowrap;',
    'background:var(--dsh-surface);color:var(--dsh-ink-muted);border:1px solid var(--dsh-line);',
    'transition:background var(--dsh-dur-fast) var(--dsh-ease),color var(--dsh-dur-fast) var(--dsh-ease);}',
    '#' + ROOT_ID + ' .l2d-chip:hover{background:var(--dsh-surface-raised);color:var(--dsh-ink);}',
    '#' + ROOT_ID + ' .l2d-bubble{position:absolute;right:0;bottom:calc(100% + var(--dsh-space-2));max-width:200px;',
    'padding:var(--dsh-space-2) var(--dsh-space-3);',
    'border-radius:var(--dsh-radius-lg) var(--dsh-radius-lg) var(--dsh-radius-sm) var(--dsh-radius-lg);',
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
    'box-shadow:var(--dsh-shadow-3);border:1px solid var(--dsh-line);display:none;flex-direction:column;}',
    '.l2d-menu.open{display:flex;}',
    '.l2d-menu button{border:none;background:transparent;color:var(--dsh-ink);text-align:left;',
    'padding:var(--dsh-space-2) var(--dsh-space-3);border-radius:var(--dsh-radius-md);font:var(--dsh-text-sm);cursor:pointer;}',
    '.l2d-menu button:hover{background:var(--dsh-hover);}',
    '.l2d-menu .l2d-menu-title{padding:var(--dsh-space-1) var(--dsh-space-3);font:var(--dsh-text-xs);color:var(--dsh-ink-muted);}',
    '.l2d-yandere-fx{position:fixed;inset:0;pointer-events:none;z-index:2147483200;',
    'background:radial-gradient(ellipse at center,rgba(0,0,0,0) 38%,rgba(45,0,14,.6) 100%);',
    'opacity:0;transition:opacity .7s;}',
    '.l2d-yandere-fx.on{opacity:1;}',
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
    '.l2d-panel{position:fixed;right:var(--dsh-space-5);top:var(--dsh-space-5);width:304px;',
    'max-height:min(760px,calc(100vh - var(--dsh-space-8)));',
    'overflow:auto;padding:var(--dsh-space-4);border-radius:var(--dsh-radius-xl);',
    'background:var(--dsh-surface);color:var(--dsh-ink);pointer-events:auto;',
    'box-shadow:var(--dsh-shadow-3);border:1px solid var(--dsh-line);',
    'font:var(--dsh-text-sm);display:none;flex-direction:column;gap:var(--dsh-space-3);',
    'z-index:var(--dsh-z-panel,2147483200);}',
    '.l2d-panel.open{display:flex;}',
    '.l2d-panel h4{margin:0;font:var(--dsh-text-label);color:var(--dsh-ink);}',
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
    '#' + ROOT_ID + '.conversation .l2d-bubble{border-bottom-right-radius:var(--dsh-radius-sm);}',
    '#dsh-l2d-root :focus-visible,.l2d-menu :focus-visible,.l2d-panel :focus-visible{outline:2px solid var(--dsh-accent);outline-offset:2px;}'
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
    style.textContent = readTokenCss() + STYLE_TEXT;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = ROOT_ID;

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
    chipEl.title = '点击切换情境 · 拖动角色可移动';

    var gear = document.createElement('button');
    gear.className = 'l2d-gear';
    gear.type = 'button';
    gear.title = '设置';
    gear.textContent = '\u2699';
    gear.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePanel();
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
    document.body.appendChild(root);
    document.body.appendChild(menuEl);
    document.body.appendChild(panelEl);

    buildPanel();
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
  }

  function usePlaceholder() {
    if (!bodyEl || bodyEl.querySelector('.l2d-placeholder')) return;
    var ph = document.createElement('div');
    ph.className = 'l2d-placeholder';
    if (imgEl) imgEl.style.display = 'none';
    bodyEl.appendChild(ph);
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

  function applyPrefs() {
    if (!root) return;
    root.className = prefs.state;
    // 兼容旧版存下的 left/top（有数值就用，否则走右下角默认位）
    pos.x = typeof prefs.left === 'number' ? prefs.left : null;
    pos.y = typeof prefs.top === 'number' ? prefs.top : null;
    applyPos();
    if (chipEl) chipEl.textContent = LABEL[prefs.state] || '待机';
  }

  function setState(next) {
    // 手动切换优先：60s 内环境层不自动改状态，避免刚点完就被覆盖
    env.manualUntil = Date.now() + 60000;
    prefs.state = next;
    persist();
    if (root) root.className = next;
    if (chipEl) chipEl.textContent = LABEL[next] || next;
    say(BUBBLE[next] && BUBBLE[next][Math.floor(Math.random() * BUBBLE[next].length)]);
  }

  var bubbleTimer = null;
  function say(text, holdMs) {
    if (!bubbleEl || !text) return;
    bubbleEl.textContent = text;
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
    if (!L || !L.setParameter) return;
    L.setParameter(id, value, 1);
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
  var APPEARANCE_OPTIONS = [
    { name: '胸口衣服', label: '胸口衣服' },
    { name: '裙长切换', label: '裙摆样式' },
    { name: '脱鞋', label: '脱鞋' },
  ];
  var yandereOn = false;
  var yandereArmedAt = 0;
  var yandereFx = null;
  var yandereActRunId = 0;

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
    title.textContent = menuView === 'root' ? 'DSH-L2D' : menuView === 'appearance' ? '模型外观' : '面部';
    menuEl.appendChild(title);

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
      return;
    }

    menuEl.appendChild(menuButton('设置', openPanel));
    menuEl.appendChild(menuButton('对话', function () {
      var agent = window.__DSH_L2D_AGENT__ || {};
      var text = trimChatText(agent.lastAssistantText, 70) || '我在听，你说吧～';
      say(text, 5200);
      if (window.DSH_L2D && window.DSH_L2D.setExpression) window.DSH_L2D.setExpression('兔牙');
    }));
    menuEl.appendChild(menuButton('随机动作', pokeRandom));
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
  }

  function openMenuAt(e) {
    buildMenu();
    if (!menuEl) return;
    menuEl.classList.add('open');
    menuEl.setAttribute('aria-hidden', 'false');
    var w = menuEl.offsetWidth || 160;
    var h = menuEl.offsetHeight || 180;
    var x = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX));
    var y = Math.min(window.innerHeight - h - 8, Math.max(8, e.clientY));
    menuEl.style.left = x + 'px';
    menuEl.style.top = y + 'px';
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
  window.DSH_L2D_UI = {
    chatActionForReply: chatActionForReply,
    executePokeAction: executePokeAction,
    enableYandere: enableYandere,
    disableYandere: disableYandere,
    setBodyType: setBodyType,
    cycleBodyType: cycleBodyType,
    zoneAt: zoneAt,
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
    L.setParameters(vals);
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
    var L = window.DSH_L2D;
    if (!L || !L.hitTestAt) return true; // 旧渲染包/静态兜底：保持整盒可交互
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

  function runActStep(step, runId, source, skipMotions) {
    var L = window.DSH_L2D;
    if (!L || !step || !actStillCurrent(runId)) return;
    if (step.kind === 'expression') {
      if (step.clear && L.clearExpression) L.clearExpression();
      else if (step.name && L.setExpression) L.setExpression(step.name);
    } else if (step.kind === 'motion' && step.name) {
      if (!skipMotions && L.playMotionAsync) watchMotion(runId, L.playMotionAsync(step.name), source, true);
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
      });
    } else if (step.kind === 'pose' && step.pose && L.setPose) {
      L.setPose(step.pose);
    } else if (step.kind === 'look' && L.lookAt) {
      L.lookAt(step.x || 0, step.y || 0);
    }
  }

  // 整组超时：到点取消整组并让结束回执带上 reason:'timeout'。
  function timeoutActGroup(runId) {
    var L = window.DSH_L2D;
    if (!L || !actStillCurrent(runId)) return;
    if (L.noteActMotion) L.noteActMotion(runId, 'timeout', 'fail');
    cancelActTimers();
    var ev = L.finishAct ? L.finishAct(runId) : null;
    if (ev) postActEvent(ev);
    if (L.setStageBusy) L.setStageBusy({ acting: false });
  }

  // 按执行计划投放：桶内每步按自己的 atMs 投放（降级成串行后 atMs 已被拉开），
  // 不能整桶同一 tick 连发——那样降级只是改了记账，观感上仍是并行。
  // 计划由渲染包的 normalizeActPlan 生成（core/src/chain-normalize.ts），老包没有时退回串行。
  function playActPlan(plan, runId, source, skipMotions) {
    var buckets = (plan && plan.buckets) || [];
    for (var b = 0; b < buckets.length; b++) {
      (function (bucket) {
        for (var i = 0; i < bucket.steps.length; i++) {
          (function (node) {
            var at = Math.max(0, Number(node.atMs) || 0);
            if (at <= 0) {
              runActStep(node.step, runId, source, skipMotions);
            } else {
              pokeTimers.push(setTimeout(function () {
                runActStep(node.step, runId, source, skipMotions);
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

  function playActSteps(chain, runId, source, skipMotions, plan) {
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
      playActPlan(usePlan, runId, source, skipMotions);
      return;
    }
    var elapsed = 0;
    for (var i = 0; i < chain.length; i++) {
      var step = chain[i];
      var delay = Math.max(0, Number(step.delayMs) || 0);
      elapsed += delay;
      if (elapsed <= 0) {
        runActStep(step, runId, source, skipMotions);
      } else {
        (function (pending, at) {
          pokeTimers.push(setTimeout(function () {
            runActStep(pending, runId, source, skipMotions);
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

  function playbackAct(chain, runId, source, holdOnly, plan) {
    var flush = closesToFlush(chain);
    var motions = chainMotionPlan(chain);
    pendingCloses = [];
    cancelActTimers();
    if (holdOnly) return;
    // 另一只手的关闭不能和新动作同时发，否则状态机把后一个吞掉。先播新动作，等它返回再收。
    if (flush.length && motions.length) {
      playSerial(motions, flush, runId, source);
      playActSteps(chain, runId, source, true, plan);
      return;
    }
    if (flush.length) playSerial([], flush, runId, source);
    playActSteps(chain, runId, source, false, plan);
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
    playbackAct(chain, admission.runId, source, !!action.holdOnly, planForLife);
    emitActEvents(admission.events);
    // 先挂上结束回执，避免步骤里抛错后槽位一直占着。
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
    var roll = Math.random();

    try {
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
    if (settings.clickMode === 'api') return pokeByApi();
    return pokeRandom();
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
  // 性能：挂件显示尺寸 593×741，4096 贴图（5×64MiB=320MiB 显存）纯属浪费；
  // 2048 档肉眼无差，显存降到 80MiB、采样带宽降到 1/4。
  // 回到高清只要把下面文件名换回 '大肥鱼.dsl2d.model3.json'。
  var MODEL_URL =
    '/dsh-l2d/model/' + encodeURIComponent('大肥鱼.dsl2d.2048.model3.json');

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
    if (rendererReady || rendererFailed) return;
    loadScriptOnce('dsh-l2d-core', versioned('/dsh-l2d/core.js'))
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
          modelUrl: MODEL_URL,
          width: box.w,
          height: box.h,
          zoom: 1,
          dpr: renderScale()
        });
      })
      .then(function () {
        rendererReady = true;
        if (imgEl) imgEl.style.display = 'none';
        watchResize();
        watchDpr(); // 跨屏/缩放变化时按新 DPI 重排
        watchFocusScale(); // 焦点/可见性变化时切换超采样倍率
        bindPhysics(); // 渲染就绪后立刻挂上每帧物理钩子
      })
      .catch(function (err) {
        var reason = err && err.message ? err.message : String(err);
        fallbackToImage(reason);
        say('渲染失败，已切回静态图', 3000);
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
  var settings = { scale: 1, soundEnabled: true, soundVolume: 0.7, refreshSeconds: 60, hasApiKey: false, eyeFollow: true, agentLink: true, clickMode: 'random', spontaneousChat: true, memeStyle: true, memeLevel: 50, autoAct: true, systemSensor: false, mediaSensor: false, petMode: true };
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
   * 强制刷新状态（调试用）：重新拉宿主设置 + 销毁并重新挂载渲染包，
   * 不重载整个 DSH 页面。修改设置后状态没生效、渲染卡住、或改了 overlay.js
   * 想当场复位时用它。也挂在 window.__DSH_L2D_FORCE_REFRESH__ 上，控制台可直接调。
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
    initRenderer();
    say('已强制刷新', 1800);
  }
  try { window.__DSH_L2D_FORCE_REFRESH__ = forceRefreshState; } catch (err) { /* ignore */ }

  function closePanel() {
    if (!panelEl) return;
    panelOpen = false;
    panelEl.classList.remove('open');
  }

  function openPanel() {
    if (!panelEl) return;
    panelOpen = true;
    panelEl.classList.add('open');
  }

  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
  }

  function row(labelText, control) {
    var wrap = document.createElement('div');
    wrap.className = 'l2d-row';
    var lab = document.createElement('label');
    lab.textContent = labelText;
    wrap.appendChild(lab);
    wrap.appendChild(control);
    return wrap;
  }

  function buildPanel() {
    if (!panelEl) return;
    panelEl.innerHTML = '';

    var title = document.createElement('h4');
    title.textContent = 'DSH-L2D 设置';
    panelEl.appendChild(title);

    var keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = settings.hasApiKey ? '已保存，留空则不修改' : 'sk-...';
    keyInput.autocomplete = 'off';
    panelEl.appendChild(row('DeepSeek API Key（仅用于查询余额）', keyInput));

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
    panelEl.appendChild(row('音效开关 / 音量', soundWrap));

    var scaleInput = document.createElement('input');
    scaleInput.type = 'range';
    scaleInput.min = '0.6';
    scaleInput.max = '2.0';
    scaleInput.step = '0.05';
    scaleInput.value = String(settings.scale);
    scaleInput.addEventListener('input', function () {
      applyScale(scaleInput.value);
    });
    panelEl.appendChild(row('角色缩放', scaleInput));

    var refreshInput = document.createElement('input');
    refreshInput.type = 'number';
    refreshInput.min = '15';
    refreshInput.max = '3600';
    refreshInput.value = String(settings.refreshSeconds);
    panelEl.appendChild(row('余额刷新间隔（秒）', refreshInput));

    var agentToggle = document.createElement('input');
    agentToggle.type = 'checkbox';
    agentToggle.checked = settings.agentLink !== false;
    panelEl.appendChild(row('工作区联动', agentToggle));
    var sysToggle = document.createElement('input');
    sysToggle.type = 'checkbox';
    sysToggle.checked = settings.systemSensor === true;
    panelEl.appendChild(row('系统联动（CPU/内存/电量/断网）', sysToggle));
    var mediaToggle = document.createElement('input');
    mediaToggle.type = 'checkbox';
    mediaToggle.checked = settings.mediaSensor === true;
    panelEl.appendChild(row('媒体律动（音乐播放时轻摆）', mediaToggle));

    var petToggle = document.createElement('input');
    petToggle.type = 'checkbox';
    petToggle.checked = settings.petMode !== false; // 默认开（桌宠模式为正式行为）
    panelEl.appendChild(row('桌宠模式（悬停零触发 · 点击只摸头）', petToggle));

    var eyeFollowToggle = document.createElement('input');
    eyeFollowToggle.type = 'checkbox';
    eyeFollowToggle.checked = settings.eyeFollow !== false; // 默认开（与宿主默认值/存量迁移一致）
    panelEl.appendChild(row('眼神跟随（鼠标驱动视线/头/身体）', eyeFollowToggle));

    var clickMode = document.createElement('select');
    var modeRandom = document.createElement('option');
    modeRandom.value = 'random';
    modeRandom.textContent = '随机动作';
    var modeApi = document.createElement('option');
    modeApi.value = 'api';
    modeApi.textContent = 'DeepSeek 决定';
    clickMode.appendChild(modeRandom);
    clickMode.appendChild(modeApi);
    clickMode.value = settings.clickMode === 'api' ? 'api' : 'random';
    panelEl.appendChild(row('戳一戳动作', clickMode));

    var spontaneousChat = document.createElement('input');
    spontaneousChat.type = 'checkbox';
    spontaneousChat.checked = settings.spontaneousChat !== false;
    panelEl.appendChild(row('自发聊天', spontaneousChat));

    var memeToggle = document.createElement('input');
    memeToggle.type = 'checkbox';
    memeToggle.checked = settings.memeStyle !== false;
    panelEl.appendChild(row('梗味人设', memeToggle));

    var memeLevel = document.createElement('input');
    memeLevel.type = 'range';
    memeLevel.min = '0';
    memeLevel.max = '100';
    memeLevel.step = '5';
    memeLevel.value = String(settings.memeLevel);
    panelEl.appendChild(row('玩梗程度', memeLevel));

    var autoAct = document.createElement('input');
    autoAct.type = 'checkbox';
    autoAct.checked = settings.autoAct !== false;
    panelEl.appendChild(row('API 自主动作', autoAct));

    var hint = document.createElement('div');
    hint.className = 'l2d-hint';
    hint.textContent = '单击角色播放动作；悬停显示余额与当前峰/谷价。开启自发聊天后，完成状态会回流最新回复，空闲时偶尔说话。';
    panelEl.appendChild(hint);

    // 调试：强制刷新状态（不重载页面，重拉宿主设置 + 重挂渲染包）
    var forceBtn = document.createElement('button');
    forceBtn.type = 'button';
    forceBtn.textContent = '↻ 强制刷新状态';
    forceBtn.title = '重新拉取宿主设置并销毁/重挂渲染包（调试用，不重载页面）';
    forceBtn.addEventListener('click', function () {
      closePanel();
      forceRefreshState();
    });
    panelEl.appendChild(forceBtn);

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
    panelEl.appendChild(actions);
  }

  // 启动：初始化链任何一步抛错都不能让整个 IIFE 死掉——否则后面的 DSH_L2D_AI
  // 赋值、AI 轮询、事件桥全部不执行（App 页"角色可见但桥死"就是这种形态）。
  // catch 里做两件事：① 把原因送回宿主（error 在反向桥白名单内，落 reverse/state.json，
  // 以后不用 F12 也能查）；② 补挂 AI 轮询，保证 MCP 指令通道活着。
  function bootOverlay() {
    try {
      ensureMounted();
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
    // 不写 localStorage：远离/回归是瞬态，别让下次启动卡在 away；手动切换仍由 setState 持久化
    if (root) root.className = next;
    if (chipEl) chipEl.textContent = LABEL[next] || next;
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
  function postAiResult(payload) {
    payload.token = __aiLeaseToken;
    payload.epoch = __aiLeaseEpoch;
    return fetch('/dsh-l2d/ai/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (!r.ok) console.warn('[dsh-l2d] AI 回执被拒 id=' + payload.id + ' status=' + r.status);
      return r;
    });
  }

  function startAiPoll() {
    if (aiPollTimer) return;
    aiPollTimer = setInterval(function () {
      if (aiPollHoldTicks > 0) { aiPollHoldTicks--; return; } // 租约被他人持有：降频轮询
      if (!window.DSH_L2D_AI) return;
      fetch('/dsh-l2d/ai/poll?consumer=' + encodeURIComponent(__aiConsumerId) + '&version=' + encodeURIComponent(__bootTag || ''), { cache: 'no-store' })
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
            Promise.resolve(window.DSH_L2D_AI.exec(c.name, c.args, c.id))
              .then(function (res) {
                if (!res || res.ok === false) {
                  // skipped / conflict 是状态机的正常结果，不当成异常刷屏
                  if (!res || (res.reason !== 'skipped' && res.reason !== 'conflict' && res.status !== 'skipped' && res.status !== 'conflict')) {
                    console.warn('[dsh-l2d] AI 指令执行失败', c.name, res);
                  }
                }
                postAiResult({ id: c.id, result: res || { ok: false, reason: 'empty' } })
                  .catch(function () { /* 结果回写失败，MCP 会超时 */ });
              })
              .catch(function (err) {
                postAiResult({ id: c.id, result: { ok: false, reason: String(err && err.message ? err.message : err) } })
                  .catch(function () { /* ignore */ });
              });
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
            return L.playMotionAsync(String(a.group || ''), {
              index: Number(a.index || 0),
              awaitFinish: a.awaitFinish === true,
            }).then(function (r) {
              if (r.status === 'ok') return { ok: true, status: r.status, group: r.group, slot: r.slot, dir: r.dir };
              return { ok: false, reason: r.reason || r.status, status: r.status, group: r.group };
            });
          }
          case 'l2d_emote': {
            var moodName = String(a.mood || a.name || '').trim();
            if (!moodName) return { ok: false, reason: 'empty-mood' };
            if (L.emotionSignal) L.emotionSignal({ type: 'mood', data: { mood: moodName } });
            return { ok: true, mood: moodName };
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
