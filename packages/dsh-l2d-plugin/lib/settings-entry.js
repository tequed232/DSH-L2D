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
    '/* Editor style: host sidebar settings button + second-level menu. */',
    '.dsh-se-btn{display:flex;align-items:center;gap:10px;width:100%;min-width:0;box-sizing:border-box;min-height:var(--studio-control-h,36px);padding:0 var(--studio-gutter-sm,12px);border:1px solid transparent;border-left:2px solid transparent;border-radius:var(--studio-radius-sm,6px);background:transparent;color:inherit;font:var(--studio-text-label,500 12px/1.4 system-ui);cursor:pointer;text-align:left;flex:none;white-space:nowrap;transition:background var(--studio-transition-fast,100ms),color var(--studio-transition-fast,100ms),border-color var(--studio-transition-fast,100ms),box-shadow var(--studio-transition-fast,100ms),transform var(--studio-transition-fast,100ms);}',
    '.dsh-se-btn:hover{background:var(--studio-hover,rgba(232,236,245,.06));}',
    '.dsh-se-btn:active{background:var(--studio-active,rgba(232,236,245,.11));transform:translateY(1px);}',
    '.dsh-se-btn:focus-visible{outline:none;box-shadow:var(--studio-focus-ring,0 0 0 2px #141821,0 0 0 4px #9dc1ff);}',
    '.dsh-se-btn[data-state~="selected"]{background:var(--studio-selected,rgba(157,193,255,.16));border-left-color:var(--studio-accent,#9dc1ff);}',
    '.dsh-se-btn:disabled,.dsh-se-btn[data-state~="disabled"]{opacity:var(--studio-state-disabled-opacity,.42);cursor:not-allowed;}',
    '.dsh-se-btn[data-state~="loading"]{cursor:progress;}',
    '.dsh-se-btn[data-state~="error"]{border-color:var(--studio-danger,#ffb4ab);color:var(--studio-danger,#ffb4ab);}',
    '.dsh-se-btn[data-state~="success"]{border-color:var(--studio-ok,#8fd0a8);color:var(--studio-ok,#8fd0a8);}',
    '.dsh-se-btn svg{flex:none;width:16px;height:16px;}',
    '.dsh-se-btn .dsh-se-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.dsh-se-btn.dsh-se-compact{padding:0;justify-content:center;}',
    '.dsh-se-btn.dsh-se-compact .dsh-se-label{display:none;}',
    '.dsh-se-menu{position:fixed;min-width:200px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:6px;margin:0;list-style:none;box-sizing:border-box;border-radius:var(--studio-radius-md,10px);background:var(--studio-surface-2,#1c2230);color:var(--studio-ink,#e9ecf3);border:1px solid var(--studio-line-strong,rgba(232,236,245,.22));box-shadow:var(--studio-shadow-2,0 8px 24px rgba(0,0,0,.45));z-index:2147483300;display:none;flex-direction:column;}',
    '.dsh-se-menu.open{display:flex;}',
    '.dsh-se-menu button,.dsh-se-menu a{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;min-height:var(--studio-row-h,36px);padding:0 10px;border:1px solid transparent;border-radius:var(--studio-radius-sm,6px);background:transparent;color:var(--studio-ink-2,#aeb7c7);font:var(--studio-text-sm,400 13px/1.5 system-ui);cursor:pointer;text-align:left;text-decoration:none;white-space:nowrap;transition:background var(--studio-transition-fast,100ms),color var(--studio-transition-fast,100ms),border-color var(--studio-transition-fast,100ms),box-shadow var(--studio-transition-fast,100ms),transform var(--studio-transition-fast,100ms);}',
    '.dsh-se-menu a{text-decoration:none;color:inherit;}',
    '.dsh-se-menu button:hover,.dsh-se-menu a:hover{background:var(--studio-hover,rgba(232,236,245,.06));color:var(--studio-ink,#e9ecf3);}',
    '.dsh-se-menu button:active,.dsh-se-menu a:active{background:var(--studio-active,rgba(232,236,245,.11));transform:translateY(1px);}',
    '.dsh-se-menu button:focus-visible,.dsh-se-menu a:focus-visible{outline:none;box-shadow:var(--studio-focus-ring,0 0 0 2px #141821,0 0 0 4px #9dc1ff);}',
    '.dsh-se-menu button[data-state~="active"],.dsh-se-menu a[data-state~="active"]{background:var(--studio-selected,rgba(157,193,255,.16));color:var(--studio-accent-soft-ink,#d6e6ff);}',
    '.dsh-se-menu button[data-state~="disabled"],.dsh-se-menu a[data-state~="disabled"]{opacity:var(--studio-state-disabled-opacity,.42);cursor:not-allowed;}',
    '.dsh-se-menu .dsh-se-menu-title{padding:6px 10px 8px;font:var(--studio-text-micro,500 10px/1.3 monospace);letter-spacing:1px;text-transform:uppercase;color:var(--studio-ink-3,#737f92);}',
    '@media (max-width:1023px){.dsh-se-menu{min-width:180px;}}',
    '@media (max-width:719px){.dsh-se-menu{min-width:160px;max-width:calc(100vw - 24px);}.dsh-se-btn{gap:8px;}}',
    '@media (prefers-reduced-motion: reduce){.dsh-se-btn,.dsh-se-menu button,.dsh-se-menu a{transition:none !important;}}'
  ].join('');

  var GEAR_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="2.2"/>'
    + '<path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/>'
    + '</svg>';

  var MENU_ITEMS = [
    { group: 'appearance', label: '外观' },
    { group: 'behavior', label: '行为与联动' },
    { group: 'account', label: '账户与余额' },
    { label: '参数监视台', href: '/dsh-l2d/test.html' }
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
      var el;
      if (item.href) {
        el = document.createElement('a');
        el.setAttribute('role', 'menuitem');
        el.setAttribute('href', item.href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener');
        el.textContent = item.label;
        el.addEventListener('click', function () {
          closeMenu();
        });
      } else {
        el = document.createElement('button');
        el.type = 'button';
        el.setAttribute('role', 'menuitem');
        el.textContent = item.label;
        el.addEventListener('click', function () {
          closeMenu();
          SettingsWindowManager.open(item.group);
        });
      }
      menu.appendChild(el);
    });
    // Esc / 外点关闭；ArrowUp/Down 在菜单项间移动焦点
    menu.addEventListener('keydown', function (e) {
      var items = menu.querySelectorAll('button, a');
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
    var first = m.querySelector('button, a');
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
