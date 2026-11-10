/* =========================================================================
   Folds：库分组 / 检查器卡片 / 顶栏 / 状态栏的折叠状态（高度过渡见 CSS .fold-body）。
   - 渲染函数用 Folds.cls(key) 取初始类名，事件委托在 document 上，重绘不丢状态
   - 收起后仍保留标题行：图标/色块 + 名称 + 计数
   - 状态持久化 localStorage 'dsh-mg-folds.v1'（{ key: true }，file:// 受限时静默降级）
   ========================================================================= */
var Folds = {
  KEY: 'dsh-mg-folds.v1',
  state: {},
  load: function () {
    try {
      var raw = localStorage.getItem(this.KEY);
      if (raw) { var s = JSON.parse(raw); if (s && typeof s === 'object') this.state = s; }
    } catch (err) { /* file:// 降级 */ }
  },
  save: function () { try { localStorage.setItem(this.KEY, JSON.stringify(this.state)); } catch (err) { /* ignore */ } },
  is: function (key) { return !!this.state[key]; },
  cls: function (key) { return this.is(key) ? ' is-folded' : ''; },
  aria: function (key) { return this.is(key) ? 'false' : 'true'; },
  /* 标题行：chevron + 内容；键盘可达（button 语义） */
  head: function (key, inner, extraCls) {
    return '<button type="button" class="fold-head ' + (extraCls || '') + '" data-fold-key="' + esc(key) + '" aria-expanded="' + this.aria(key) + '">' +
      '<span class="fold-chev" aria-hidden="true">▾</span>' + inner + '</button>';
  },
  set: function (key, folded) {
    if (folded) this.state[key] = true; else delete this.state[key];
    this.save();
    var head = document.querySelector('[data-fold-key="' + key + '"]');
    if (head) {
      head.setAttribute('aria-expanded', folded ? 'false' : 'true');
      var box = head.closest('[data-fold]');
      if (box) box.classList.toggle('is-folded', !!folded);
    }
    this.applyBars();
  },
  toggle: function (key) { this.set(key, !this.is(key)); },
  applyBars: function () {
    var tb = this.is('bar.topbar'), st = this.is('bar.status');
    document.body.classList.toggle('topbar-folded', tb);
    document.body.classList.toggle('status-folded', st);
    var a = document.getElementById('topbar-fold'), b = document.getElementById('status-fold');
    if (a) { a.setAttribute('aria-expanded', tb ? 'false' : 'true'); a.title = tr(tb ? 'fold.topbarLbl' : 'fold.topbar'); }
    if (b) { b.setAttribute('aria-expanded', st ? 'false' : 'true'); b.title = tr(st ? 'fold.statusOpen' : 'fold.status'); }
    if (typeof UI !== 'undefined' && UI.fitTopbar) UI.fitTopbar();
  },
  init: function () {
    this.load();
    var self = this;
    document.addEventListener('click', function (e) {
      var h = e.target.closest ? e.target.closest('[data-fold-key]') : null;
      if (h) { e.preventDefault(); self.toggle(h.getAttribute('data-fold-key')); }
    });
    var a = document.getElementById('topbar-fold'), b = document.getElementById('status-fold');
    if (a) a.addEventListener('click', function () { self.toggle('bar.topbar'); });
    if (b) b.addEventListener('click', function () { self.toggle('bar.status'); });
    this.applyBars();
  }
};
