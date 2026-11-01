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

  var prefs = { state: 'idle', left: null, top: null };
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (saved && STATES.indexOf(saved.state) >= 0) prefs.state = saved.state;
    if (typeof saved.left === 'number') prefs.left = saved.left;
    if (typeof saved.top === 'number') prefs.top = saved.top;
  } catch (e) { /* 隐私模式忽略 */ }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (e) { /* ignore */ }
  }

  var STYLE_TEXT = [
    // 用 transform 定位而不是 left/top：拖拽时只改合成层偏移，不触发布局重排。
    // will-change 提前把图层独立出来，避免拖动过程中反复提升/降级。
    '#' + ROOT_ID + '{position:fixed;left:0;top:0;width:240px;height:300px;',
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
    '#' + ROOT_ID + ' .l2d-chip{position:absolute;left:50%;bottom:-2px;transform:translateX(-50%);',
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
    '#' + ROOT_ID + '.away .l2d-body{filter:grayscale(.55) brightness(.72);opacity:.8;}',
    '#' + ROOT_ID + '.conversation .l2d-chip{background:rgba(208,188,255,.94);color:#381e72;',
    'border-color:rgba(56,30,114,.22);}',
    '#' + ROOT_ID + '.work .l2d-chip{background:rgba(239,184,200,.92);color:#492532;',
    'border-color:rgba(73,37,50,.22);}',
    '#' + ROOT_ID + ' .l2d-gear{position:absolute;top:2px;right:2px;width:26px;height:26px;border-radius:999px;',
    'display:grid;place-items:center;pointer-events:auto;cursor:pointer;border:none;',
    'background:rgba(28,27,32,.72);color:#e6e0e9;font-size:14px;line-height:1;opacity:0;',
    'transition:opacity .2s ease,background .2s ease;}',
    '#' + ROOT_ID + ':hover .l2d-gear{opacity:1;}',
    '#' + ROOT_ID + ' .l2d-gear:hover{background:rgba(56,52,66,.95);}',
    '#' + ROOT_ID + ' .l2d-panel{position:absolute;right:0;bottom:0;width:268px;padding:16px;',
    'border-radius:18px;background:rgba(24,22,28,.98);color:#e6e0e9;pointer-events:auto;',
    'box-shadow:0 12px 40px rgba(0,0,0,.55);border:1px solid rgba(230,224,233,.12);',
    'font-size:12.5px;display:none;flex-direction:column;gap:12px;}',
    '#' + ROOT_ID + ' .l2d-panel.open{display:flex;}',
    '#' + ROOT_ID + ' .l2d-panel h4{margin:0;font-size:13px;font-weight:500;letter-spacing:.3px;color:#d0bcff;}',
    '#' + ROOT_ID + ' .l2d-row{display:flex;flex-direction:column;gap:6px;}',
    '#' + ROOT_ID + ' .l2d-row label{font-size:11.5px;color:#cac4d0;}',
    '#' + ROOT_ID + ' .l2d-row input[type=password],#' + ROOT_ID + ' .l2d-row input[type=number]',
    '{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:10px;',
    'border:1px solid rgba(230,224,233,.18);background:rgba(255,255,255,.06);color:#e6e0e9;',
    'font-size:12px;outline:none;}',
    '#' + ROOT_ID + ' .l2d-inline{display:flex;align-items:center;gap:10px;}',
    '#' + ROOT_ID + ' .l2d-inline input[type=range]{flex:1;}',
    '#' + ROOT_ID + ' .l2d-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:2px;}',
    '#' + ROOT_ID + ' .l2d-actions button{border:none;border-radius:999px;padding:7px 16px;font-size:12px;',
    'cursor:pointer;background:rgba(255,255,255,.1);color:#e6e0e9;}',
    '#' + ROOT_ID + ' .l2d-actions button.primary{background:#d0bcff;color:#381e72;}',
    '#' + ROOT_ID + ' .l2d-hint{font-size:11px;color:#938f99;line-height:1.5;}',
    '#' + ROOT_ID + '.conversation .l2d-bubble{border-bottom-right-radius:4px;}'
  ].join('');

  var root = null;
  var imgEl = null;
  var bubbleEl = null;
  var chipEl = null;
  var bodyEl = null;

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

    root.appendChild(bubbleEl);
    root.appendChild(bodyEl);
    root.appendChild(chipEl);
    root.appendChild(gear);
    root.appendChild(panelEl);
    document.body.appendChild(root);

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

  // 角色左上角的屏幕坐标。null 表示还没定位过，此时落到右下角默认位。
  // 拖拽惯性已按用户要求移除：这里只保留最稳定的 1:1 跟手定位。
  var pos = { x: null, y: null };

  /** 把 pos 同步到合成层（只改 transform，不碰布局） */
  function applyPos() {
    if (!root) return;
    if (pos.x === null || pos.y === null) {
      var w = root.offsetWidth || 240;
      var h = root.offsetHeight || 300;
      pos.x = Math.max(0, window.innerWidth - w - 24);
      pos.y = Math.max(0, window.innerHeight - h - 24);
    }
    root.style.transform =
      'translate3d(' + pos.x + 'px,' + pos.y + 'px,0)';
  }

  /** 限制在可视区域内（允许露出一部分，但不要推到完全看不见） */
  function clampPos(x, y) {
    var w = root ? root.offsetWidth || 240 : 240;
    var h = root ? root.offsetHeight || 300 : 300;
    return {
      x: Math.max(-w * 0.35, Math.min(window.innerWidth - w * 0.65, x)),
      y: Math.max(0, Math.min(window.innerHeight - h * 0.25, y)),
    };
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

  function formatBalance(data) {
    if (!data) return '余额获取失败';
    if (!data.ok) {
      if (data.reason === 'no-key') return '未配置 API Key';
      return '余额暂时不可用';
    }
    var symbol = data.currency === 'USD' ? '$' : '¥';
    var total = typeof data.total === 'number' ? data.total.toFixed(2) : '—';
    return '余额 ' + symbol + total + (data.stale ? '（缓存）' : '');
  }

  function showBalance() {
    say('查询中…', 1800);
    fetchBalance().then(function (data) {
      say(formatBalance(data), 4200);
    });
  }

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

  /** 每帧物理已按用户要求停用：避免任何拖拽/松手惯性把角色甩走。 */
  function physicsTick() {
    return;
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
      // 拖拽惯性已移除：直接 1:1 跟手。
      pos.x = pendingX;
      pos.y = pendingY;
      applyPos();
      if (window.DSH_L2D && window.DSH_L2D.markActive) window.DSH_L2D.markActive();
    }

    bodyEl.addEventListener('pointerdown', function (e) {
      if (!root) return;
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

      // 惯性已移除：松手直接落到当前位置。
      if (moved) {
        pos.x = pendingX;
        pos.y = pendingY;
        applyPos();
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

    // 窗口尺寸变化时重新夹位置，防止角色被挤出可视区域
    window.addEventListener('resize', function () {
      if (pos.x === null) return;
      var c = clampPos(pos.x, pos.y);
      pos.x = c.x;
      pos.y = c.y;
      applyPos();
    });
  }

  // ---------------------------------------------------------------- 交互
  function bindClick() {
    // 单击角色：显示当前 API 余额（与 Whale 挂件的「点一下看余额」一致）
    bodyEl.addEventListener('click', function () {
      showBalance();
    });

    // 悬停 350ms 也弹出余额对话框；移开取消未触发的悬停
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

    bodyEl.addEventListener('dblclick', function () {
      cycleState();
    });

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
      var sc = Math.min(1.6, Math.max(0.6, Number(settings.scale) || 1));
      w = Math.round(240 * sc);
      h = Math.round(300 * sc);
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
  function startAnim() {
    var t0 = performance.now();
    function frame(now) {
      var t = (now - t0) / 1000;
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
  var settings = { scale: 1, soundEnabled: true, soundVolume: 0.7, refreshSeconds: 60, hasApiKey: false };
  var panelOpen = false;

  function applyScale(scale) {
    if (!root) return;
    var sc = Math.min(1.6, Math.max(0.6, Number(scale) || 1));
    root.style.width = Math.round(240 * sc) + 'px';
    root.style.height = Math.round(300 * sc) + 'px';
    if (rendererReady && window.DSH_L2D && window.DSH_L2D.layout) {
      var w = Math.round(240 * sc);
      var h = Math.round(300 * sc);
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
    scaleInput.max = '1.6';
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

    var hint = document.createElement('div');
    hint.className = 'l2d-hint';
    hint.textContent = '工作区联动会读取 DSH 会话状态（thinking/working/attention/error/idle），并触发对应的表情与姿势。';
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
        agentLink: agentToggle.checked
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
  var agentLink = { state: 'unknown', lastAt: 0, timer: 0 };
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
      if (L.setPose) L.setPose({ right: 'finger' });
      if (L.lookAt) L.lookAt(0.2, 0.1);
    },
    attention: function () {
      var L = window.DSH_L2D;
      if (!L) return;
      if (L.setExpression) L.setExpression('兔牙');
      if (L.setPose) L.setPose({ right: 'rest', left: 'rest' });
      if (L.lookAt) L.lookAt(0, 0);
    },
    error: function () {
      var L = window.DSH_L2D;
      if (!L) return;
      if (L.setExpression) L.setExpression('流冷汗');
      if (L.setPose) L.setPose({ right: 'rest', left: 'rest' });
      if (L.lookAt) L.lookAt(0, -0.18);
    },
    idle: function () {
      var L = window.DSH_L2D;
      if (!L) return;
      if (L.setPose) L.setPose({ right: 'rest', left: 'rest' });
      if (L.lookAt) L.lookAt(0, 0);
    },
  };

  function reactAgentState(next, meta) {
    var now = Date.now();
    if (next === agentLink.state) return;
    agentLink.state = next;
    agentLink.lastAt = now;
    // 动作链失败不能打断后续状态联动
    try {
      if (AGENT_CHAIN[next]) AGENT_CHAIN[next]();
      if (next === 'working' && meta && meta.lastTool) {
        say('正在' + meta.lastTool + '…', 2400);
      } else if (next === 'error' && meta && meta.lastError) {
        say('出错了：' + String(meta.lastError).slice(0, 60), 4200);
      } else if (next === 'attention') {
        say('我看完啦，等你下一句', 2400);
      }
    } catch (e) {
      console.warn('[dsh-l2d] agent chain failed', e);
    }
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
            var res = window.DSH_L2D_AI.exec(c.name, c.args);
            if (!res || !res.ok) {
              console.warn('[dsh-l2d] AI 指令执行失败', c.name, res);
            }
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
            var okMot = L.playMotion(String(a.group || ''), Number(a.index || 0));
            return okMot ? { ok: true } : { ok: false, error: 'unknown-motion-group: ' + a.group };
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
