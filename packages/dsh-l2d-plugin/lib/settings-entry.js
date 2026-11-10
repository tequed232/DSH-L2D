/**
 * DSH-L2D 全局设置入口（UI-FLOAT 里程碑④，自包含原生 JS，无构建依赖）
 *
 * - 侧边栏底部、账户信息上方插入「设置」按钮（宽 100% / 高 42px / 圆角 11px / 图标+文字）。
 *   侧栏折叠（宽度 <72px）时只留图标 + Tooltip。
 * - 点击弹二级菜单（安静浮层，appledesign 风格）：直达新设置页对应分区；
 *   菜单项两行式（标题 + 分区内容说明），入口一目了然。
 * - SettingsWindowManager：右侧抽屉 iframe 加载新设置页 /dsh-l2d/settings.html#sec-xxx；
 *   单实例：已开再点只聚焦+切分区锚点（页内 hashchange 平滑滚动）；
 *   返回路径明确：标题栏「完成」按钮 / Esc / 新窗口打开外链。旧 overlay 内嵌面板已退役（见 Settings-UI.md §8.3）。
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
    '.dsh-se-menu .dsh-se-menu-title{padding:6px 10px 2px;font:var(--studio-text-micro,500 10px/1.3 monospace);letter-spacing:1px;text-transform:uppercase;color:var(--studio-ink-3,#737f92);}',
    '.dsh-se-menu .dsh-se-menu-hint{padding:0 10px 8px;font:var(--studio-text-micro,400 10px/1.4 system-ui);color:var(--studio-ink-3,#737f92);}',
    '.dsh-se-menu .dsh-se-label{flex:1;min-width:0;}',
    '.dsh-se-menu .dsh-se-label b{display:block;font:var(--studio-text-sm,500 13px/1.35 system-ui);color:var(--studio-ink,#e9ecf3);}',
    '.dsh-se-menu .dsh-se-label small{display:block;font:400 11px/1.4 system-ui;color:var(--studio-ink-3,#737f92);}',
    '.dsh-se-drawer{position:fixed;top:0;right:0;bottom:0;width:min(460px,calc(100vw - 24px));display:none;flex-direction:column;box-sizing:border-box;background:var(--studio-surface-2,#1c2230);color:var(--studio-ink,#e9ecf3);border-left:1px solid var(--studio-line-strong,rgba(232,236,245,.22));box-shadow:var(--studio-shadow-2,0 8px 24px rgba(0,0,0,.45));z-index:2147483300;}',
    '.dsh-se-drawer.open{display:flex;}',
    '.dsh-se-drawer .dsh-se-drawer-head{display:flex;align-items:center;gap:10px;flex:none;min-height:44px;padding:0 12px;border-bottom:1px solid var(--studio-line,rgba(232,236,245,.10));}',
    '.dsh-se-drawer .dsh-se-drawer-head b{flex:1;min-width:0;font:var(--studio-text-sm,500 13px/1.4 system-ui);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.dsh-se-drawer .dsh-se-drawer-head a,.dsh-se-drawer .dsh-se-drawer-head button{display:inline-flex;align-items:center;gap:6px;flex:none;border:1px solid var(--studio-line,rgba(232,236,245,.16));border-radius:var(--studio-radius-sm,6px);background:transparent;color:var(--studio-ink-2,#aeb7c7);font:var(--studio-text-label,500 12px/1.2 system-ui);padding:5px 10px;cursor:pointer;text-decoration:none;}',
    '.dsh-se-drawer .dsh-se-drawer-head a:hover,.dsh-se-drawer .dsh-se-drawer-head button:hover{background:var(--studio-hover,rgba(232,236,245,.06));color:var(--studio-ink,#e9ecf3);}',
    '.dsh-se-drawer .dsh-se-drawer-head button.primary{background:var(--studio-accent,#9dc1ff);border-color:var(--studio-accent,#9dc1ff);color:var(--studio-on-accent,#0b1b33);}',
    '.dsh-se-drawer iframe{flex:1;min-height:0;width:100%;border:0;background:#fff;}',
    '@media (prefers-reduced-motion: reduce){.dsh-se-btn,.dsh-se-menu button,.dsh-se-menu a,.dsh-se-drawer{transition:none !important;}}'
  ].join('');

  var GEAR_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="2.2"/>'
    + '<path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/>'
    + '</svg>';

  /* 新设置页分区直达：副标题说明每个分区管什么；返回路径 = 抽屉「完成」/ Esc / 新窗口打开 */
  /* URL 运行时探测：真机 /dsh-l2d/settings，DevServer /settings，file:// 独立页 /dsh-l2d/settings.html */
  var SETTINGS_URL_CANDS = ['/dsh-l2d/settings', '/settings', '/dsh-l2d/settings.html'];
  /* 节点编辑器直达：菜单点「节点编辑器」直接开 motion-graph.html（新窗口），不再滚到设置页 05 卡片。
     同样运行时 HEAD 探测（真机 /dsh-l2d/motion-graph.html，DevServer /motion-graph.html）；
     探测失败（file:// 独立打开等）时兜底回落到设置抽屉 sec-nodegraph 分区。 */
  var EDITOR_URL_CANDS = ['/dsh-l2d/motion-graph.html', '/motion-graph.html'];
  var editorUrl = null;
  function probeEditorUrl() {
    var i = 0;
    (function tryNext() {
      if (i >= EDITOR_URL_CANDS.length || editorUrl) return;
      var url = EDITOR_URL_CANDS[i++];
      fetch(url, { method: 'HEAD' }).then(function (r) {
        if (r.ok) editorUrl = url;
        else tryNext();
      }).catch(function () { tryNext(); });
    })();
  }
  /* 三页导航：「常规设置」直达第一分区 sec-display（页内含 显示/角色/情绪/动画 四分区滚动浏览） */
  var MENU_ITEMS = [
    { sec: 'display', label: '常规设置', sub: '显示布局 · 角色模型 · 情绪行为 · 动画性能' },
    { sec: 'preview', label: '动作预览', sub: '点按动作或表情，在角色上即时预览' },
    { sec: 'nodegraph', label: '节点编辑器', sub: '直达编辑器 · 动作编排与槽位导入导出' },
    { sec: 'monitor', label: '性能监控台', sub: '实时读数 · 能力重扫 · 参数监视台' }
  ];

  var btn = null;
  var menu = null;
  var ro = null;
  var tries = 0;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

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
    title.textContent = '设置 · 分区直达';
    menu.appendChild(title);
    var hint = document.createElement('div');
    hint.className = 'dsh-se-menu-hint';
    hint.textContent = '改动即时保存 · 关闭面板即返回宿主';
    menu.appendChild(hint);
    MENU_ITEMS.forEach(function (item) {
      var el;
      var inner = '<b>' + esc(item.label) + '</b><small>' + esc(item.sub || '') + '</small>';
      if (item.href) {
        el = document.createElement('a');
        el.setAttribute('role', 'menuitem');
        el.setAttribute('href', item.href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener');
        el.innerHTML = '<span class="dsh-se-label">' + inner + '</span>';
        el.addEventListener('click', function () {
          closeMenu();
        });
      } else {
        el = document.createElement('button');
        el.type = 'button';
        el.setAttribute('role', 'menuitem');
        el.innerHTML = '<span class="dsh-se-label">' + inner + '</span>';
        el.addEventListener('click', function () {
          closeMenu();
          if (item.sec === 'nodegraph' && editorUrl) {
            // 直达节点编辑器（新窗口）。window.open 在用户手势同步上下文内调用，不会被弹窗拦截。
            window.open(editorUrl, '_blank', 'noopener');
            return;
          }
          SettingsWindowManager.open(item.sec);
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
  // 右侧抽屉 iframe 加载新设置页（单实例）。已开再点 → 切分区锚点（页内 hashchange 平滑滚动）。
  // 返回路径：标题栏「完成」/ Esc；「新窗口打开」提供独立标签页出口。
  var SettingsWindowManager = {
    drawer: null,
    iframe: null,
    resolvedUrl: null,
    popLink: null,
    resolveUrl: function (cb) {
      if (this.resolvedUrl) return cb(this.resolvedUrl);
      var self = this, i = 0;
      (function tryNext() {
        if (i >= SETTINGS_URL_CANDS.length) return cb(null);
        var url = SETTINGS_URL_CANDS[i++];
        fetch(url, { method:'HEAD' }).then(function (r) {
          if (r.ok) { self.resolvedUrl = url; cb(url); } else tryNext();
        }).catch(function () { tryNext(); });
      })();
    },
    ensureDrawer: function () {
      if (this.drawer) return this.drawer;
      var wrap = document.createElement('div');
      wrap.className = 'dsh-se-drawer';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-label', 'DSH-L2D 设置');
      var head = document.createElement('div');
      head.className = 'dsh-se-drawer-head';
      var title = document.createElement('b');
      title.textContent = '设置 · DSH-L2D';
      var pop = document.createElement('a');
      pop.setAttribute('href', SETTINGS_URL_CANDS[0]);
      pop.setAttribute('target', '_blank');
      pop.setAttribute('rel', 'noopener');
      pop.textContent = '新窗口打开';
      this.popLink = pop;
      var done = document.createElement('button');
      done.type = 'button';
      done.className = 'primary';
      done.textContent = '完成';
      done.addEventListener('click', function () { SettingsWindowManager.close(); });
      head.appendChild(title);
      head.appendChild(pop);
      head.appendChild(done);
      var frame = document.createElement('iframe');
      frame.setAttribute('title', '设置页');
      wrap.appendChild(head);
      wrap.appendChild(frame);
      document.body.appendChild(wrap);
      this.drawer = wrap;
      this.iframe = frame;
      return wrap;
    },
    open: function (sec) {
      this.ensureDrawer();
      var self = this;
      var hash = sec ? '#sec-' + sec : '';
      this.resolveUrl(function (url) {
        if (!url) return; // 全部不可达（file:// 独立打开等）：抽屉保持空白，不伪造内容
        if (self.popLink) self.popLink.setAttribute('href', url + hash);
        try {
          if (self.iframe.src && self.iframe.src.indexOf(url) === 0 && self.iframe.contentWindow.location.href) {
            self.iframe.contentWindow.location.hash = sec ? 'sec-' + sec : '';
          } else {
            self.iframe.src = url + hash;
          }
        } catch (e) {
          self.iframe.src = url + hash;
        }
      });
      this.drawer.classList.add('open');
    },
    close: function () {
      if (this.drawer) this.drawer.classList.remove('open');
    },
    isOpen: function () {
      return !!(this.drawer && this.drawer.classList.contains('open'));
    },
    focus: function () {
      if (this.drawer && !this.isOpen()) this.drawer.classList.add('open');
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

  // 节点编辑器 URL 预热探测：挂载即开始，菜单点击时已有缓存，避免首次点击被弹窗拦截器盯上
  probeEditorUrl();

  // 外点关闭二级菜单
  document.addEventListener('pointerdown', function (e) {
    if (!menuIsOpen()) return;
    if (e.target.closest && (e.target.closest('.dsh-se-menu') || e.target.closest('.dsh-se-btn'))) return;
    closeMenu();
  }, true);
  // 全局 Esc：先关二级菜单，其次关设置抽屉（返回宿主路径）
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menuIsOpen()) {
      e.stopPropagation();
      closeMenu();
      if (btn) btn.focus();
      return;
    }
    if (e.key === 'Escape' && SettingsWindowManager.isOpen()) {
      e.stopPropagation();
      SettingsWindowManager.close();
      if (btn) btn.focus();
    }
  }, true);
})();
