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
  'use strict';

  if (window.__DSH_L2D_OVERLAY__) return;
  window.__DSH_L2D_OVERLAY__ = true;

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
    '#' + ROOT_ID + '{position:fixed;left:0;top:0;width:320px;height:400px;',
    'z-index:2147483000;pointer-events:none;user-select:none;-webkit-user-select:none;',
    'will-change:transform;transform:translate3d(0,0,0);contain:layout style;',
    'font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}',
    '#' + ROOT_ID + ' .l2d-body{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;',
    'pointer-events:auto;cursor:grab;transition:filter .3s ease,opacity .3s ease;}',
    '#' + ROOT_ID + ' .l2d-body.dragging{cursor:grabbing;}',
    '#' + ROOT_ID + ' .l2d-canvas{width:100%;height:100%;display:block;pointer-events:none;}',
    '#' + ROOT_ID + ' .l2d-body img{width:100%;height:100%;object-fit:contain;',
    'filter:drop-shadow(0 10px 26px rgba(0,0,0,.38));',
    'transition:transform .25s cubic-bezier(.34,1.4,.64,1);will-change:transform;pointer-events:none;}',
    '#' + ROOT_ID + ' .l2d-body:hover img{margin-bottom:4px;}',
    '#' + ROOT_ID + ' .l2d-chip{position:absolute;left:50%;top:-34px;bottom:auto;transform:translateX(-50%);',
    'pointer-events:auto;cursor:pointer;padding:3px 10px;border-radius:999px;',
    'font-size:11px;line-height:1.4;white-space:nowrap;',
    'background:rgba(28,27,32,.82);color:#e6e0e9;border:1px solid rgba(230,224,233,.16);',
    'backdrop-filter:blur(8px);transition:background .2s ease,color .2s ease;}',
    '#' + ROOT_ID + ' .l2d-chip:hover{background:rgba(48,45,56,.92);}',
    '#' + ROOT_ID + ' .l2d-bubble{position:absolute;right:0;bottom:calc(100% + 8px);max-width:200px;',
    'padding:8px 12px;border-radius:14px 14px 4px 14px;font-size:12.5px;line-height:1.5;',
    'background:rgba(240,236,248,.97);color:#1d1b20;box-shadow:0 6px 20px rgba(0,0,0,.28);',
    'opacity:0;transform:translateY(6px) scale(.96);transform-origin:bottom right;',
    'transition:opacity .22s ease,transform .22s cubic-bezier(.34,1.4,.64,1);pointer-events:none;}',
    '#' + ROOT_ID + ' .l2d-bubble.show{opacity:1;transform:translateY(0) scale(1);}',
    '#' + ROOT_ID + ' .l2d-bubble .price-up{color:#c62828;font-weight:800;}',
    '#' + ROOT_ID + ' .l2d-bubble .price-down{color:#1b5e20;font-weight:800;}',
    '#' + ROOT_ID + ' .l2d-bubble .price-sub{display:block;font-size:10.5px;line-height:1.35;color:#5f5f66;}',
    '#' + ROOT_ID + ' .l2d-price{position:absolute;left:50%;top:calc(100% + 8px);transform:translateX(-50%);',
    'max-width:min(360px,calc(100vw - 24px));padding:6px 10px;border-radius:12px;font-size:10.5px;line-height:1.35;',
    'white-space:nowrap;background:rgba(24,22,28,.9);color:#e6e0e9;border:1px solid rgba(230,224,233,.12);',
    'box-shadow:0 6px 20px rgba(0,0,0,.28);opacity:0;transition:opacity .22s ease;pointer-events:none;}',
    '#' + ROOT_ID + ' .l2d-price.show{opacity:1;}',
    '#' + ROOT_ID + ' .l2d-price .price-up{color:#ff8a80;font-weight:800;}',
    '#' + ROOT_ID + ' .l2d-price .price-down{color:#a5d6a7;font-weight:800;}',
    '#' + ROOT_ID + ' .l2d-price .price-sub{display:block;font-size:9.5px;color:#cac4d0;}',
    '.l2d-menu{position:fixed;z-index:2147483100;min-width:168px;padding:6px;',
    'border-radius:14px;background:rgba(24,22,28,.98);color:#e6e0e9;pointer-events:auto;',
    'box-shadow:0 10px 34px rgba(0,0,0,.5);border:1px solid rgba(230,224,233,.12);display:none;flex-direction:column;gap:2px;}',
    '.l2d-menu.open{display:flex;}',
    '.l2d-menu button{border:none;background:transparent;color:#e6e0e9;text-align:left;',
    'padding:8px 10px;border-radius:10px;font-size:12px;cursor:pointer;}',
    '.l2d-menu button:hover{background:rgba(208,188,255,.18);color:#f3edf7;}',
    '.l2d-menu .l2d-menu-title{padding:4px 10px 2px;font-size:10.5px;color:#938f99;}',
    '.l2d-yandere-fx{position:fixed;inset:0;pointer-events:none;z-index:2147483200;',
    'background:radial-gradient(ellipse at center,rgba(0,0,0,0) 38%,rgba(45,0,14,.6) 100%);',
    'opacity:0;transition:opacity .7s;}',
    '.l2d-yandere-fx.on{opacity:1;}',
    '#' + ROOT_ID + '.away .l2d-body{filter:grayscale(.55) brightness(.72);opacity:.8;}',
    '#' + ROOT_ID + '.conversation .l2d-chip{background:rgba(208,188,255,.94);color:#381e72;',
    'border-color:rgba(56,30,114,.22);}',
    '#' + ROOT_ID + '.work .l2d-chip{background:rgba(239,184,200,.92);color:#492532;',
    'border-color:rgba(73,37,50,.22);}',
    '#' + ROOT_ID + ' .l2d-gear{position:absolute;top:-34px;right:-4px;width:28px;height:28px;border-radius:999px;',
    'display:grid;place-items:center;pointer-events:auto;cursor:pointer;border:none;',
    'background:rgba(28,27,32,.72);color:#e6e0e9;font-size:14px;line-height:1;opacity:0;',
    'transition:opacity .2s ease,background .2s ease;}',
    '#' + ROOT_ID + ':hover .l2d-gear{opacity:1;}',
    '#' + ROOT_ID + ' .l2d-gear:hover{background:rgba(56,52,66,.95);}',
    '.l2d-panel{position:fixed;right:28px;top:28px;width:296px;max-height:min(760px,calc(100vh - 56px));',
    'overflow:auto;padding:16px;border-radius:18px;background:rgba(24,22,28,.98);color:#e6e0e9;pointer-events:auto;',
    'box-shadow:0 12px 40px rgba(0,0,0,.55);border:1px solid rgba(230,224,233,.12);',
    'font-size:12.5px;display:none;flex-direction:column;gap:12px;z-index:2147483200;}',
    '.l2d-panel.open{display:flex;}',
    '.l2d-panel h4{margin:0;font-size:13px;font-weight:500;letter-spacing:.3px;color:#d0bcff;}',
    '.l2d-panel .l2d-row{display:flex;flex-direction:column;gap:6px;}',
    '.l2d-panel .l2d-row label{font-size:11.5px;color:#cac4d0;}',
    '.l2d-panel .l2d-row input[type=password],.l2d-panel .l2d-row input[type=number]',
    '{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:10px;',
    'border:1px solid rgba(230,224,233,.18);background:rgba(255,255,255,.06);color:#e6e0e9;',
    'font-size:12px;outline:none;}',
    '.l2d-panel .l2d-inline{display:flex;align-items:center;gap:10px;}',
    '.l2d-panel .l2d-inline input[type=range]{flex:1;}',
    '.l2d-panel .l2d-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:2px;}',
    '.l2d-panel .l2d-actions button{border:none;border-radius:999px;padding:7px 16px;font-size:12px;',
    'cursor:pointer;background:rgba(255,255,255,.1);color:#e6e0e9;}',
    '.l2d-panel .l2d-actions button.primary{background:#d0bcff;color:#381e72;}',
    '.l2d-panel .l2d-hint{font-size:11px;color:#938f99;line-height:1.5;}',
    '#' + ROOT_ID + '.conversation .l2d-bubble{border-bottom-right-radius:4px;}'
  ].join('');

  var root = null;
  var imgEl = null;
  var bubbleEl = null;
  var chipEl = null;
  var bodyEl = null;
  var priceEl = null;
  var menuEl = null;

  function ensureMounted() {
    if (document.getElementById(ROOT_ID)) return;
    if (!document.body) return;

    var style = document.createElement('style');
    style.setAttribute('data-dsh-l2d', 'style');
    style.textContent = STYLE_TEXT;
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
    startAiPoll();
    startAgentPoll();
    initEmotionSensors();
  }

  function usePlaceholder() {
    if (!bodyEl || bodyEl.querySelector('.l2d-placeholder')) return;
    var ph = document.createElement('div');
    ph.className = 'l2d-placeholder';
    ph.style.cssText = [
      'width:64%;height:64%;margin-bottom:30px;',
      'border-radius:46% 46% 42% 42%;',
      'background:linear-gradient(160deg,rgba(208,188,255,.9),rgba(133,183,235,.55));',
      'box-shadow:0 10px 26px rgba(0,0,0,.35);'
    ].join('');
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
    try {
      if (L && L.injectEmotionIntent) {
        L.injectEmotionIntent({
          ruleId: 'yandere-mode',
          source: 'menu',
          priority: 95,
          expression: '黑脸',
          motion: '抚胸手打开',
          motionClose: '抚胸手关闭',
          closeAfterMs: 8000,
          pose: { right: 'finger' },
          look: { x: 0, y: 0.35 },
          bubble: '(ÒωÓ) 让我看看用户硬盘里有什么好东西',
          holdMs: 9000,
        });
      } else {
        applyAppearance('黑脸');
        say('(ÒωÓ) 让我看看用户硬盘里有什么好东西', 6000);
      }
    } catch (e) {
      /* ignore */
    }
    setYandereFx(true);
  }

  function disableYandere() {
    yandereOn = false;
    yandereArmedAt = 0;
    setYandereFx(false);
    appearanceCurrent = null;
    var L = window.DSH_L2D;
    try {
      if (L && L.playMotionAsync) L.playMotionAsync('抚胸手关闭').catch(function () { /* 没打开就跳过 */ });
      if (L && L.clearExpression) L.clearExpression();
      if (L && L.clearGaze) L.clearGaze();
      if (L && L.setPose) L.setPose({ right: 'rest', left: 'rest' });
    } catch (e) {
      /* 退出失败也不能把特效留在屏幕上 */
    }
    say('…什么都没看到。', 3000);
    setTimeout(buildMenu, 30); // 刷新菜单文案
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
    return { chain: chain, bubble: '', silent: true };
  }

  // 调试/自动化测试钩子：不进 AI 工具白名单
  window.DSH_L2D_UI = {
    chatActionForReply: chatActionForReply,
    executePokeAction: executePokeAction,
    setBodyType: setBodyType,
    cycleBodyType: cycleBodyType,
    zoneAt: zoneAt,
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

    bodyEl.addEventListener('pointerdown', function (e) {
      if (!root) return;
      // 裙摆是独立手势：垂直拖拽调裙长，不拖动容器
      if (zoneAt(e) === 'skirt') {
        e.preventDefault();
        startSkirtDrag(e);
        return;
      }

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

    bodyEl.addEventListener('pointermove', function (e) {
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
      if (moved && e && e.preventDefault) e.preventDefault();
    }

    bodyEl.addEventListener('pointerup', endDrag);
    bodyEl.addEventListener('pointercancel', endDrag);

    // 窗口尺寸变化时直接吸附；缩放/换体型不做“慢慢滑回”。
    window.addEventListener('resize', function () {
      if (pos.x === null) return;
      var c = clampPos(pos.x, pos.y);
      pos.x = c.x;
      pos.y = c.y;
      snapSpringToTarget();
    });
  }

  // ---------------------------------------------------------------- 戳一戳动作
  // 动作链批次：每次戳一下生成新 runId，旧链的延时步骤会被打断。
  // 参考 FULASKA/-live2d- 的 ActionBus 设计：受理成功不等于必须播完，后续高优可打断。
  var pokeTimers = [];
  var pokeRunId = 0;

  function clearPokeTimers() {
    pokeRunId++;
    for (var i = 0; i < pokeTimers.length; i++) clearTimeout(pokeTimers[i]);
    pokeTimers = [];
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

  function randomOf(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function scheduleCloseMotion(closeMotion, delayMs, runId) {
    var L = window.DSH_L2D;
    if (!L || !closeMotion || !L.playMotionAsync) return;
    pokeTimers.push(setTimeout(function () {
      if (runId !== pokeRunId) return;
      L.playMotionAsync(closeMotion).catch(function () { /* 状态机可能已处理 */ });
    }, delayMs || 6000));
  }

  var actingTimer = 0;

  function executePokeAction(action) {
    var L = window.DSH_L2D;
    if (!L || !action) return;
    var runId = clearPokeTimers();

    // 兼容旧字段；新协议使用 chain：expression / motion / pose / look
    var chain = Array.isArray(action.chain) ? action.chain : [];
    if (!chain.length) {
      if (action.expression) chain.push({ kind: 'expression', name: action.expression });
      if (action.motion) chain.push({ kind: 'motion', name: action.motion, closeMotion: action.closeMotion, closeAfterMs: action.closeAfterMs });
      if (action.pose) chain.push({ kind: 'pose', pose: action.pose });
      if (action.look) chain.push({ kind: 'look', x: action.look.x, y: action.look.y });
    }

    var elapsed = 0;
    var currentRunId = runId;
    function runStep(step) {
      if (!L || !step || currentRunId !== pokeRunId) return;
      if (step.kind === 'expression' && step.name && L.setExpression) {
        L.setExpression(step.name);
      } else if (step.kind === 'motion' && step.name && L.playMotionAsync) {
        L.playMotionAsync(step.name).catch(function () { /* 状态机会拒绝冲突 */ });
        if (step.closeMotion) {
          scheduleCloseMotion(step.closeMotion, step.closeAfterMs || 6000, currentRunId);
        }
      } else if (step.kind === 'keyframes' && L.playKeyframes) {
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

    if (L.setStageBusy) L.setStageBusy({ acting: true });
    if (actingTimer) clearTimeout(actingTimer);
    for (var i = 0; i < chain.length; i++) {
      var step = chain[i];
      var delay = Math.max(0, Number(step.delayMs) || 0);
      elapsed += delay;
      if (elapsed <= 0) {
        runStep(step);
      } else {
        (function (pending) {
          pokeTimers.push(setTimeout(function () { runStep(pending); }, elapsed));
        })(step);
      }
    }

    actingTimer = setTimeout(function () {
      actingTimer = 0;
      if (window.DSH_L2D && window.DSH_L2D.setStageBusy) {
        window.DSH_L2D.setStageBusy({ acting: false });
      }
    }, Math.max(400, elapsed + 1800));

    if (action.bubble) say(action.bubble, 3200);
    else if (!action.silent) say('戳戳~', 2200);
  }

  function pokeRandom() {
    var L = window.DSH_L2D;
    if (!L || !L.isReady || !L.isReady()) {
      say('模型还没准备好', 1800);
      return;
    }
    var runId = clearPokeTimers();
    var cap = pokeCapabilities();
    var expressions = cap.expressions;
    var motions = cap.motions.filter(function (name) { return name.endsWith('打开'); });
    var roll = Math.random();

    try {
      if (roll < 0.36 && expressions.length) {
        var expression = randomOf(expressions);
        L.setExpression(expression);
        if (L.lookAt) L.lookAt((Math.random() - 0.5) * 0.7, Math.random() * 0.35);
        say(expression, 2800);
        return;
      }

      if (roll < 0.76 && motions.length) {
        var motion = randomOf(motions);
        L.playMotionAsync(motion).catch(function () { say('这个动作先让位', 2200); });
        scheduleCloseMotion(motion.replace(/打开$/, '关闭'), 5200 + Math.random() * 2600, runId);
        say('看这个~', 2600);
        return;
      }

      var poses = ['finger', 'grass', 'chest'];
      var poseName = randomOf(poses);
      var pose = poseName === 'chest'
        ? { right: 'rest', left: 'chest' }
        : { right: poseName, left: 'rest' };
      L.setPose(pose);
      say(poseName === 'finger' ? '看这里！' : poseName === 'grass' ? '给你草草' : '抱抱~', 2800);
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
    bodyEl.addEventListener('pointerdown', function (e) {
      downX = e.clientX;
      downY = e.clientY;
    });
    bodyEl.addEventListener('click', function (e) {
      if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) return;
      if (Date.now() - Number(window.__DSH_L2D_SKIRT_DRAGGED__ || 0) < 120) return;
      handleZoneClick(e);
    });

    bodyEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      menuView = 'root'; // 右键始终回到根菜单
      openMenuAt(e);
    });

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
  var MODEL_URL =
    '/dsh-l2d/model/' + encodeURIComponent('大肥鱼.dsl2d.2048.model3.json');

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
        if (window.DSH_L2D && window.DSH_L2D.layout) window.DSH_L2D.layout(box.w, box.h, 1);
      });
      ro.observe(root);
    } catch (e) { /* ignore */ }
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
    loadScriptOnce('dsh-l2d-core', '/dsh-l2d/core.js')
      .then(function () {
        if (!window.Live2DCubismCore) throw new Error('Core 未挂载');
        return loadScriptOnce('dsh-l2d-renderer', '/dsh-l2d/renderer.js');
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
          zoom: 1
        });
      })
      .then(function () {
        rendererReady = true;
        if (imgEl) imgEl.style.display = 'none';
        watchResize();
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
  var settings = { scale: 1, soundEnabled: true, soundVolume: 0.7, refreshSeconds: 60, hasApiKey: false, agentLink: true, clickMode: 'random', spontaneousChat: true, memeStyle: true, memeLevel: 50, autoAct: true, systemSensor: false, mediaSensor: false };
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
        applyScale(settings.scale);
        syncSystemSensor();
        syncMediaSensor();
      })
      .catch(function () { /* ignore */ });
  }

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
        mediaSensor: mediaToggle.checked
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureMounted);
  } else {
    ensureMounted();
  }

  // ---------------------------------------------------------------- 工作区会话联动
  //
  // 参照 dsh-pet-indesktop 的 Agent Link：读取 DSH 会话事件并聚合为状态，
  // 状态切换时触发一条轻量动作链（表情/视线/姿势），不做高频重播。
  var agentLink = { state: 'unknown', lastAt: 0, timer: 0, lastSpokeAt: 0 };
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
    var now = Date.now();
    if (now - agentLink.lastSpokeAt < (minGapMs || 8000)) return false;
    agentLink.lastSpokeAt = now;
    say(text, 5200);
    return true;
  }

  var AGENT_CHAIN = {
    thinking: function () {
      var L = window.DSH_L2D;
      if (!L) return;
      if (L.setExpression) L.setExpression('加载');
      if (L.lookAt) L.lookAt(0, 0.28);
    },
    working: function () {
      var L = window.DSH_L2D;
      if (!L) return;
      if (L.setExpression) L.setExpression('加载');
      if (L.lookAt) L.lookAt(0.2, 0.1);
    },
    attention: function () {
      var L = window.DSH_L2D;
      if (!L) return;
      if (L.setExpression) L.setExpression('兔牙');
      if (L.lookAt) L.lookAt(0, 0);
    },
    error: function () {
      var L = window.DSH_L2D;
      if (!L) return;
      if (L.setExpression) L.setExpression('流冷汗');
      if (L.lookAt) L.lookAt(0, -0.18);
    },
    idle: function () {
      var L = window.DSH_L2D;
      if (!L) return;
      // 不在这里复位四肢：会覆盖用户/API 的姿势意图
      if (L.lookAt) L.lookAt(0, 0);
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
      if (next === 'error' && window.DSH_L2D && window.DSH_L2D.emotionSignal) {
        window.DSH_L2D.emotionSignal({ type: 'state', data: { state: 'error' } });
      }
    } catch (e3) {
      /* 情绪信号失败忽略 */
    }
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
  var emotionSensors = { mouseBound: false, sysTimer: 0, batteryBound: false, vx: 0, vy: 0 };

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

  /** 眼神/躯体跟随：把鼠标位置换算成模型注视目标（含边缘死区），喂给渲染包平滑执行 */
  function driveGaze(e) {
    var L = window.DSH_L2D;
    if (!L || !L.gaze || !L.isReady || !L.isReady()) return;
    var rect = root ? root.getBoundingClientRect() : null;
    if (!rect || !rect.width) return;
    // 近似以「脸部」为注视原点（模型上部 35% 处）
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height * 0.35;
    var nx = (e.clientX - cx) / (window.innerWidth * 0.45);
    var ny = (e.clientY - cy) / (window.innerHeight * 0.45);
    // 死区：正对模型 12% 半径内不转头，防止注视抖动
    var dist = Math.sqrt(nx * nx + ny * ny);
    if (dist < 0.12) {
      nx = 0;
      ny = 0;
    } else {
      nx = (nx - (nx < 0 ? -0.12 : 0.12)) / 0.88;
      ny = (ny - (ny < 0 ? -0.12 : 0.12)) / 0.88;
    }
    nx = Math.max(-1, Math.min(1, nx));
    ny = Math.max(-1, Math.min(1, ny));
    // 屏幕坐标 y 向下，模型 AngleY/EyeBallY 正值是「抬头」——取反
    L.gaze(nx, -ny);
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
          driveGaze(e); // 注视要跟手，节流放到渲染端平滑
          if (now - pushT < 250) return;
          pushT = now;
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
          emotionPush({ type: 'mouse', data: { click: true } });
        },
        { passive: true }
      );
    }
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
      if (emotionSensors.sysTimer) {
        clearInterval(emotionSensors.sysTimer);
        emotionSensors.sysTimer = 0;
        window.removeEventListener('online', onNetChange);
        window.removeEventListener('offline', onNetChange);
      }
      return;
    }
    if (emotionSensors.sysTimer) return;
    emotionSensors.sysTimer = setInterval(function () {
      fetch('/dsh-l2d/sys-metrics.json', { cache: 'no-store' })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (d) {
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
      })
      .catch(function () {
        /* 无电池设备忽略 */
      });
  }

  // ---------------------------------------------------------------- AI 指令轮询
  //
  // 宿主侧 /dsh-l2d/ai/call 收到的指令入队，这里每 400ms 取一次并执行。
  // 用轮询而不是长连接：插件环境没有稳定的 WebSocket，轮询失败可以自愈。
  var aiPollTimer = 0;

  function startAiPoll() {
    if (aiPollTimer) return;
    aiPollTimer = setInterval(function () {
      if (!window.DSH_L2D_AI) return;
      fetch('/dsh-l2d/ai/poll', { cache: 'no-store' })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (d) {
          if (!d || !d.calls || !d.calls.length) return;
          d.calls.forEach(function (c) {
            Promise.resolve(window.DSH_L2D_AI.exec(c.name, c.args))
              .then(function (res) {
                if (!res || res.ok === false) {
                  // skipped / conflict 是状态机的正常结果，不当成异常刷屏
                  if (!res || (res.reason !== 'skipped' && res.reason !== 'conflict' && res.status !== 'skipped' && res.status !== 'conflict')) {
                    console.warn('[dsh-l2d] AI 指令执行失败', c.name, res);
                  }
                }
                fetch('/dsh-l2d/ai/result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ id: c.id, result: res || { ok: false, reason: 'empty' } }),
                }).catch(function () { /* 结果回写失败，MCP 会超时 */ });
              })
              .catch(function (err) {
                fetch('/dsh-l2d/ai/result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ id: c.id, result: { ok: false, reason: String(err && err.message ? err.message : err) } }),
                }).catch(function () { /* ignore */ });
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

    /** 执行一次工具调用 */
    exec: function (name, args) {
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
            var chain = Array.isArray(a.chain) ? a.chain : [];
            if (!chain.length) return { ok: false, reason: 'empty-chain' };
            executePokeAction({ chain: chain, bubble: a.bubble || '', silent: !a.bubble });
            return { ok: true, steps: chain.length };
          }
          case 'l2d_get_state': {
            return {
              ok: true,
              ready: !!(L.isReady && L.isReady()),
              info: L.getInfo ? L.getInfo() : null,
              emotion: L.getEmotionState ? L.getEmotionState() : null,
              pose: L.getPose ? L.getPose() : null,
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
            var r = L.setParameters(a.values || {});
            return { ok: r.failed.length === 0, applied: r.ok, failed: r.failed };
          }
          case 'l2d_play_keyframes': {
            // AI 自编动作：tracks = [{ param, keys: [[t_ms, value], ...] }]
            var tracks = Array.isArray(a.tracks) ? a.tracks : [];
            var n = L.playKeyframes(tracks, { duration: a.duration, loop: a.loop === true });
            return n > 0 ? { ok: true, tracks: n } : { ok: false, error: 'no-valid-tracks' };
          }
          case 'l2d_stop_keyframes': {
            L.stopKeyframes();
            return { ok: true };
          }
          case 'l2d_reset_pose': {
            var n = L.resetPose();
            return { ok: true, params: n };
          }
          default:
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
