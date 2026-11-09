/* =========================================================================
   PanelLayers：监看浮窗的图层式管理（Photoshop 图层语义）。
   - 可拖动：面板头部为拖拽手柄，落点 clamp 在画布内，位置持久化
   - 可收起：折叠为头部窄条（data-fp-collapse 按钮）
   - 置顶/调序：pointerdown 点击面板即提到最上层；图层清单可 ↑↓ 调序、●/○ 显隐
   - z 分配：order 数组 index → z = 30+i（低于右键菜单 46 与模态 60，不干扰原功能）
   - 持久化 localStorage 'dsh-mg-panels.v1'；file:// 受限时仅内存生效
   ========================================================================= */
var PanelLayers = {
  KEY: 'dsh-mg-panels.v1',
  available: true,
  panels: [
    { id: 'sim-panel', name: 'layer.sim' },
    { id: 'minimap-wrap', name: 'layer.minimap' },
    { id: 'monitor-win', name: 'layer.monitor' },
    { id: 'exec-console', name: 'layer.console' },
    { id: 'json-preview', name: 'layer.json' }
  ],
  state: { order: ['sim-panel', 'minimap-wrap', 'monitor-win', 'exec-console', 'json-preview'], collapsed: {}, hidden: {}, pos: {} },
  load: function () {
    try {
      var raw = localStorage.getItem(this.KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && Array.isArray(s.order)) {
          // 只收已知面板，顺序补齐未知缺项
          var known = this.panels.map(function (p) { return p.id; });
          this.state.order = s.order.filter(function (id) { return known.indexOf(id) >= 0; });
          known.forEach(function (id) { if (this.state.order.indexOf(id) < 0) this.state.order.push(id); }, this);
          this.state.collapsed = s.collapsed || {};
          this.state.hidden = s.hidden || {};
          this.state.pos = s.pos || {};
        }
      }
    } catch (err) { this.available = false; }
  },
  save: function () {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.state)); }
    catch (err) { this.available = false; }
  },
  zFor: function (id) {
    var i = this.state.order.indexOf(id);
    return 30 + (i < 0 ? 0 : i);
  },
  apply: function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.style.zIndex = this.zFor(id);
    el.classList.toggle('fp-collapsed', !!this.state.collapsed[id]);
    el.classList.toggle('user-hidden', !!this.state.hidden[id]);
    var p = this.state.pos[id];
    if (p) {
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    }
  },
  applyAll: function () {
    var self = this;
    this.state.order.forEach(function (id) { self.apply(id); });
  },
  raise: function (id) {
    var o = this.state.order;
    if (o[o.length - 1] === id) { this.apply(id); return false; }
    this.state.order = o.filter(function (x) { return x !== id; });
    this.state.order.push(id);
    this.save(); this.applyAll(); this.renderList();
    return true;
  },
  toggleCollapse: function (id) {
    this.state.collapsed[id] = !this.state.collapsed[id];
    this.save(); this.apply(id); this.renderList();
  },
  toggleHidden: function (id) {
    this.state.hidden[id] = !this.state.hidden[id];
    this.save(); this.apply(id); this.renderList();
  },
  move: function (id, dir) {
    var o = this.state.order.slice();
    var i = o.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= o.length) return;
    o.splice(i, 1); o.splice(j, 0, id);
    this.state.order = o;
    this.save(); this.applyAll(); this.renderList();
  },
  setPos: function (id, x, y) {
    this.state.pos[id] = { x: Math.round(x), y: Math.round(y) };
    this.save();
  },
  makeDraggable: function (id, handleSel) {
    var el = document.getElementById(id), h = el && el.querySelector(handleSel), self = this;
    if (!el || !h || h.dataset.fpBound) return;
    h.dataset.fpBound = '1';
    h.classList.add('fp-drag');
    h.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return; // 头部按钮不触发拖拽
      self.raise(id);
      var r = el.getBoundingClientRect(), wr = el.parentElement.getBoundingClientRect();
      var ox = e.clientX - r.left, oy = e.clientY - r.top;
      el.style.left = (r.left - wr.left) + 'px';
      el.style.top = (r.top - wr.top) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
      var last = null;
      var move = function (ev) {
        var x = Math.max(0, Math.min(ev.clientX - wr.left - ox, wr.width - 60));
        var y = Math.max(0, Math.min(ev.clientY - wr.top - oy, wr.height - 30));
        el.style.left = x + 'px'; el.style.top = y + 'px';
        last = { x: x, y: y };
      };
      var up = function () {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (last) self.setPos(id, last.x, last.y);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      e.preventDefault();
    });
    // 点击面板任意处即置顶（capture，不干扰内部点击语义）
    el.addEventListener('pointerdown', function () { self.raise(id); }, true);
  },
  renderList: function () {
    var pop = document.getElementById('layers-pop');
    if (!pop) return;
    var self = this;
    var html = '<div class="lp-head">' + esc(tr('layer.head')) + '</div>';
    this.state.order.slice().reverse().forEach(function (id) {
      var p = null;
      self.panels.forEach(function (x) { if (x.id === id) p = x; });
      if (!p) return;
      var hid = !!self.state.hidden[id], col = !!self.state.collapsed[id];
      html += '<div class="lp-row" data-lp="' + id + '">' +
        '<button class="lp-btn" data-act="vis" title="' + esc(tr(hid ? 'layer.show' : 'layer.hide')) + '" aria-label="' + esc(tr(hid ? 'layer.show' : 'layer.hide')) + '">' + (hid ? '○' : '●') + '</button>' +
        '<span class="lp-name">' + esc(tr(p.name)) + '</span>' +
        '<button class="lp-btn" data-act="top" title="' + esc(tr('layer.top')) + '" aria-label="' + esc(tr('layer.top')) + '">⤒</button>' +
        '<button class="lp-btn" data-act="up" title="' + esc(tr('layer.up')) + '" aria-label="' + esc(tr('layer.up')) + '">↑</button>' +
        '<button class="lp-btn" data-act="down" title="' + esc(tr('layer.down')) + '" aria-label="' + esc(tr('layer.down')) + '">↓</button>' +
        '<button class="lp-btn" data-act="col" title="' + esc(tr(col ? 'common.expand' : 'common.collapseOnly')) + '" aria-label="' + esc(tr(col ? 'common.expand' : 'common.collapseOnly')) + '">' + (col ? '▢' : '—') + '</button>' +
        '</div>';
    });
    pop.innerHTML = html;
    $$('#layers-pop .lp-row').forEach(function (row) {
      var id = row.dataset.lp;
      row.querySelectorAll('.lp-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.dataset.act;
          if (act === 'vis') self.toggleHidden(id);
          else if (act === 'top') self.raise(id);
          else if (act === 'col') self.toggleCollapse(id);
          else if (act === 'up') self.move(id, 1);   // 顶层在首行：上移一层 = z 增大
          else if (act === 'down') self.move(id, -1);
        });
      });
    });
  },
  toggle: function () {
    var pop = document.getElementById('layers-pop');
    if (!pop) return;
    pop.classList.toggle('show');
    if (pop.classList.contains('show')) this.renderList();
  },
  init: function () {
    this.load(); this.applyAll();
    var self = this;
    this.makeDraggable('sim-panel', '.sp-head');
    this.makeDraggable('minimap-wrap', '.mm-head');
    this.makeDraggable('monitor-win', '.mw-head');
    $$('[data-fp-collapse]').forEach(function (b) {
      b.addEventListener('click', function () { self.toggleCollapse(b.dataset.fpCollapse); });
    });
    var btn = document.getElementById('layers-btn');
    if (btn) btn.addEventListener('click', function (e) { e.stopPropagation(); self.toggle(); });
    document.addEventListener('pointerdown', function (e) {
      var pop = document.getElementById('layers-pop');
      if (!pop || !pop.classList.contains('show')) return;
      if (e.target.closest('#layers-pop') || e.target.closest('#layers-btn')) return;
      pop.classList.remove('show');
    });
  }
};
