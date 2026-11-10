/* =========================================================================
   HintBar：画布底部操作指南（停靠在节点区下方，不遮挡节点）。
   - 收起：只保留标题行（图标 + 「操作指南」+ 摘要 + 折叠箭头），正文高度过渡收起
   - 指南实际高度写入 #canvas-wrap 的 --hint-h：画布底边与底部浮层（缩放条/小地图/控制台）随之上移
   - 底栏两个标签页：操作指南 / AI 编辑（role=tablist，←/→ 切换）；收起时点标签页会先展开
   - 状态持久化 localStorage 'dsh-mg-hint-collapsed.v1' / 'dsh-mg-dock-tab.v1'（file:// 受限时静默降级）
   ========================================================================= */
var HintBar = {
  KEY: 'dsh-mg-hint-collapsed.v1',
  TKEY: 'dsh-mg-dock-tab.v1',
  collapsed: false,
  tab: 'guide',
  init: function () {
    try { this.collapsed = localStorage.getItem(this.KEY) === '1'; } catch (err) { /* file:// 降级 */ }
    try { if (localStorage.getItem(this.TKEY) === 'ai') this.tab = 'ai'; } catch (err) { /* file:// 降级 */ }
    this.apply();
    var self = this;
    var t = document.getElementById('hint-toggle');
    if (t) t.addEventListener('click', function () { self.collapsed = !self.collapsed; self.persist(); self.apply(); });
    document.querySelectorAll('[data-dock-tab]').forEach(function (b) {
      b.addEventListener('click', function () { self.select(b.getAttribute('data-dock-tab')); });
      b.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault(); self.select(self.tab === 'guide' ? 'ai' : 'guide');
        var t2 = document.getElementById('tab-' + self.tab); if (t2) t2.focus();
      });
    });
    var bar = document.getElementById('canvas-hint');
    if (bar && window.ResizeObserver) new ResizeObserver(function () { self.measure(); }).observe(bar);
    window.addEventListener('resize', function () { self.measure(); });
  },
  select: function (tab) {
    this.tab = tab === 'ai' ? 'ai' : 'guide';
    this.collapsed = false;
    try { localStorage.setItem(this.TKEY, this.tab); } catch (err) { /* ignore */ }
    this.persist(); this.apply();
  },
  persist: function () { try { localStorage.setItem(this.KEY, this.collapsed ? '1' : '0'); } catch (err) { /* ignore */ } },
  apply: function () {
    var bar = document.getElementById('canvas-hint'), t = document.getElementById('hint-toggle');
    if (!bar) return;
    bar.classList.toggle('collapsed', this.collapsed);
    if (t) t.setAttribute('aria-expanded', this.collapsed ? 'false' : 'true');
    var tab = this.tab;
    ['guide', 'ai'].forEach(function (k) {
      var b = document.getElementById('tab-' + k), p = document.getElementById('pane-' + k);
      if (b) { b.setAttribute('aria-selected', k === tab ? 'true' : 'false'); b.tabIndex = k === tab ? 0 : -1; }
      if (p) p.hidden = k !== tab;
    });
    this.measure();
  },
  measure: function () {
    var bar = document.getElementById('canvas-hint'), wrap = document.getElementById('canvas-wrap');
    if (!bar || !wrap) return;
    wrap.style.setProperty('--hint-h', Math.ceil(bar.getBoundingClientRect().height) + 'px');
  }
};
