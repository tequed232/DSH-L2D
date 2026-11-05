/**
 * DSH-L2D 全局设置入口（UI-FLOAT 里程碑④，自包含原生 JS，无构建依赖）
 *
 * - 侧边栏底部、账户信息上方插入「设置」按钮（宽 100% / 高 42px / 圆角 11px / 图标+文字）。
 *   侧栏折叠（宽度 <72px）时只留图标 + Tooltip。
 * - 点击弹二级菜单（安静浮层，appledesign 风格）：外观 / 行为与联动 / 账户与余额；
 *   菜单项直达 overlay 设置面板对应分组（滚动 + 高亮锚点）。
 * - SettingsWindowManager 单实例：open/close/focus；已开再点只聚焦不重复创建；
 *   普通模式与 DSHBot 模式共用同一 overlay 面板实例（同一页同一 DOM），切模式状态不丢。
 * - 依赖 overlay.js 暴露的 window.DSH_L2D_UI.settings（同页注入）；overlay 未就绪时静默重试。
 */
(function () {
  'use strict';
  if (window.__DSH_SETTINGS_ENTRY__) return; // 幂等（防重复注入）
  window.__DSH_SETTINGS_ENTRY__ = true;

  var STYLE = [
    '.dsh-se-btn{display:flex;align-items:center;gap:10px;width:100%;min-width:0;box-sizing:border-box;',
    'height:42px;padding:0 12px;border:none;border-radius:11px;background:transparent;',
    'color:inherit;font:500 13px/1.4 var(--dsh-font-sans,system-ui,-apple-system,"Segoe UI",sans-serif);',
    'cursor:pointer;text-align:left;flex:none;',
    'transition:background var(--dsh-dur-fast,.15s) ease;}',
    '.dsh-se-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent);}',
    '.dsh-se-btn:focus-visible{outline:2px solid var(--dsh-accent,#4c8bf0);outline-offset:2px;}',
    '.dsh-se-btn svg{flex:none;width:16px;height:16px;}',
    '.dsh-se-btn .dsh-se-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.dsh-se-btn.dsh-se-compact{padding:0;justify-content:center;}',
    '.dsh-se-btn.dsh-se-compact .dsh-se-label{display:none;}',
    '.dsh-se-menu{position:fixed;min-width:168px;padding:4px;margin:0;list-style:none;',
    'border-radius:var(--dsh-radius-lg,12px);background:var(--dsh-surface,#1a1c22);color:var(--dsh-ink,#e8eaef);',
    'border:1px solid var(--dsh-line,rgba(255,255,255,.12));box-shadow:var(--dsh-shadow-2,0 8px 24px rgba(0,0,0,.35));',
    'z-index:2147483300;display:none;flex-direction:column;}',
    '.dsh-se-menu.open{display:flex;}',
    '.dsh-se-menu button{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;',
    'padding:8px 12px;border:none;border-radius:var(--dsh-radius-md,8px);background:transparent;',
    'color:inherit;font:400 13px/1.4 var(--dsh-font-sans,system-ui,sans-serif);cursor:pointer;text-align:left;}',
    '.dsh-se-menu button:hover,.dsh-se-menu button:focus-visible{background:var(--dsh-hover,rgba(255,255,255,.08));outline:none;}',
    '.dsh-se-menu button:focus-visible{outline:2px solid var(--dsh-accent,#4c8bf0);outline-offset:-2px;}',
    '.dsh-se-menu .dsh-se-menu-title{padding:6px 12px 4px;font:var(--dsh-text-xs,11px/1.4 sans-serif);',
    'color:var(--dsh-ink-muted,rgba(255,255,255,.55));}',
    '@media (prefers-reduced-motion: reduce){.dsh-se-btn,.dsh-se-menu button{transition:none;}}'
  ].join('');

  var GEAR_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="2.2"/>'
    + '<path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/>'
    + '</svg>';

  var MENU_ITEMS = [
    { group: 'appearance', label: '外观' },
    { group: 'behavior', label: '行为与联动' },
    { group: 'account', label: '账户与余额' }
  ];

  var btn = null;
  var menu = null;
  var ro = null;
  var tries = 0;

  function ensureStyle() {
    if (document.getElementById('dsh-se-style')) return;
    var s = document.createElement('style');
    s.id = 'dsh-se-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function findSidebar() {
    var cands = ['.sidebar', '[class*="sidebar" i]', 'aside'];
    for (var i = 0; i < cands.length; i++) {
      var nodes = document.querySelectorAll(cands[i]);
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (el.offsetWidth > 0 && el.offsetHeight > 120) return el;
      }
    }
    return null;
  }

  function findFooter(sidebar) {
    return sidebar.querySelector('.sidebar-footer, [class*="sidebar-footer" i], [class*="footer" i]');
  }

  function buildMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    menu.className = 'dsh-se-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '设置分组');
    var title = document.createElement('div');
    title.className = 'dsh-se-menu-title';
    title.textContent = '设置';
    menu.appendChild(title);
    MENU_ITEMS.forEach(function (item) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = item.label;
      b.addEventListener('click', function () {
        closeMenu();
        SettingsWindowManager.open(item.group);
      });
      menu.appendChild(b);
    });
    // Esc / 外点关闭；ArrowUp/Down 在菜单项间移动焦点
    menu.addEventListener('keydown', function (e) {
      var items = menu.querySelectorAll('button');
      var idx = Array.prototype.indexOf.call(items, document.activeElement);
      if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); if (btn) btn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (items[idx + 1] || items[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); }
    });
    document.body.appendChild(menu);
    return menu;
  }

  function openMenu() {
    if (!btn) return;
    var m = buildMenu();
    var r = btn.getBoundingClientRect();
    m.classList.add('open');
    // 定位在按钮上方，右对齐；clamp 进视口
    var mw = m.offsetWidth;
    var mh = m.offsetHeight;
    var x = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
    var y = r.top - mh - 8;
    if (y < 8) y = Math.min(r.bottom + 8, window.innerHeight - mh - 8);
    m.style.left = Math.round(x) + 'px';
    m.style.top = Math.round(y) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    var first = m.querySelector('button');
    if (first) first.focus();
  }

  function closeMenu() {
    if (!menu) return;
    menu.classList.remove('open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function menuIsOpen() { return menu && menu.classList.contains('open'); }

  // ------------------------------------------------- SettingsWindowManager
  // 单实例：窗口本体是 overlay 的设置面板（同页唯一 DOM）。已开再 open 只聚焦+锚分组。
  var SettingsWindowManager = {
    open: function (group) {
      var ui = window.DSH_L2D_UI;
      if (ui && ui.settings && ui.settings.open) {
        ui.settings.open(group);
        return true;
      }
      // overlay 未就绪：短重试（SPA 注入时序），放弃时安静失败不扰动宿主
      var n = 0;
      var timer = setInterval(function () {
        var u = window.DSH_L2D_UI;
        if (u && u.settings && u.settings.open) {
          clearInterval(timer);
          u.settings.open(group);
        } else if (++n > 20) {
          clearInterval(timer);
        }
      }, 250);
      return false;
    },
    close: function () {
      var ui = window.DSH_L2D_UI;
      if (ui && ui.settings && ui.settings.close) ui.settings.close();
    },
    focus: function () {
      var ui = window.DSH_L2D_UI;
      if (ui && ui.settings && ui.settings.isOpen && ui.settings.isOpen()) ui.settings.focus();
    }
  };
  window.DSH_L2D_SettingsWindowManager = SettingsWindowManager;

  function mount(sidebar) {
    if (btn && document.body.contains(btn)) return true;
    ensureStyle();
    var footer = findFooter(sidebar);

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dsh-se-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = '设置';
    btn.innerHTML = GEAR_SVG + '<span class="dsh-se-label">设置</span>';
    btn.addEventListener('click', function () {
      if (menuIsOpen()) closeMenu();
      else openMenu();
    });

    // Flex 真实布局占位：footer 有就放 footer 首位（账户上方），没有就挂 sidebar 底部
    if (footer) footer.insertBefore(btn, footer.firstChild);
    else sidebar.appendChild(btn);

    // 侧栏折叠（窄宽）→ 只留图标 + Tooltip
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(function () {
        btn.classList.toggle('dsh-se-compact', sidebar.offsetWidth < 72);
      });
      ro.observe(sidebar);
    } else {
      btn.classList.toggle('dsh-se-compact', sidebar.offsetWidth < 72);
    }
    return true;
  }

  // SPA 时序：侧边栏可能晚于脚本挂载，重试到出现为止（上限 40s，期间零扰动）
  var attemptTimer = setInterval(function () {
    tries++;
    var sidebar = findSidebar();
    if (sidebar && mount(sidebar)) {
      clearInterval(attemptTimer);
      return;
    }
    if (tries > 80) clearInterval(attemptTimer);
  }, 500);

  // 外点关闭二级菜单
  document.addEventListener('pointerdown', function (e) {
    if (!menuIsOpen()) return;
    if (e.target.closest && (e.target.closest('.dsh-se-menu') || e.target.closest('.dsh-se-btn'))) return;
    closeMenu();
  }, true);
  // 全局 Esc 关闭二级菜单（先于 overlay 面板的 Esc 关闭语义，菜单层优先）
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menuIsOpen()) {
      e.stopPropagation();
      closeMenu();
      if (btn) btn.focus();
    }
  }, true);
})();
