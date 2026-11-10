/* =========================================================================
   HintBar：画布顶部操作指南条的收起/展开（本轮交互改造 ①）。
   - 收起：条体隐藏，仅剩「操作指南 ?」小 chip（position:absolute left:14 top:12）
   - 状态持久化 localStorage 'dsh-mg-hint-collapsed.v1'（file:// 受限时静默降级）
   ========================================================================= */
var HintBar = {
  KEY: 'dsh-mg-hint-collapsed.v1',
  collapsed: false,
  init: function () {
    try { this.collapsed = localStorage.getItem(this.KEY) === '1'; } catch (err) { /* file:// 降级 */ }
    this.apply();
    var self = this;
    var t = document.getElementById('hint-toggle');
    if (t) t.addEventListener('click', function () { self.collapsed = true; self.persist(); self.apply(); });
    var chip = document.getElementById('hint-chip');
    if (chip) chip.addEventListener('click', function () { self.collapsed = false; self.persist(); self.apply(); });
  },
  persist: function () { try { localStorage.setItem(this.KEY, this.collapsed ? '1' : '0'); } catch (err) { /* ignore */ } },
  apply: function () {
    var bar = document.getElementById('canvas-hint'), chip = document.getElementById('hint-chip');
    if (!bar || !chip) return;
    bar.classList.toggle('hidden', this.collapsed);
    /* chip 基础样式 display:none，用 inline display 显式揭示（.hidden 只用于条体） */
    chip.style.display = this.collapsed ? 'block' : 'none';
  }
};
