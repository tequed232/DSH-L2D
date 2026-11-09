/* =========================================================================
   RailChips：三栏可收起（本轮交互改造 ②）。
   - #library / #inspector 收起 → display:none（flex 兄弟，#canvas-wrap 自动扩宽）
   - 对应 col-resizer 同步隐藏；生成一个小悬浮 chip（固定定位、可拖动、位置持久化）
   - chip 单击 → 恢复该栏（拖拽结束的 click 被抑制，不误触发）
   - 位置持久化 localStorage 'dsh-mg-rail-chips.v1'；chip 尺寸 ≤80×28px，初始贴原栏边缘
   - 正常模式的 JSON 预览由 JsonPreview 浮窗提供（接入 PanelLayers，自带收起/拖动）；
     #mg-export 仍只服务 selftest 取证。
   ========================================================================= */
var RailChips = {
  KEY: 'dsh-mg-rail-chips.v1',
  defs: {
    /* label / name / expand 为 I18n 词条键，显示时取当前界面语言 */
    lib:  { panel:'library',   resizer:'rz-lib',  label:'rail.libChip',  side:'left',  name:'rail.lib',  expand:'rail.expandLib' },
    insp: { panel:'inspector', resizer:'rz-insp', label:'rail.inspChip', side:'right', name:'rail.insp', expand:'rail.expandInsp' }
  },
  pos: {},
  load: function () {
    try {
      var raw = localStorage.getItem(this.KEY);
      if (raw) { var s = JSON.parse(raw); if (s && typeof s === 'object') this.pos = s; }
    } catch (err) { /* file:// 降级 */ }
  },
  save: function () {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.pos)); } catch (err) { /* ignore */ }
  },
  toggle: function (kind, force) {
    var d = this.defs[kind]; if (!d) return;
    var panel = document.getElementById(d.panel);
    var collapse = force === undefined ? panel.style.display !== 'none' : !!force;
    var btn = document.getElementById(kind === 'lib' ? 'lib-collapse' : 'insp-collapse');
    var chip = document.getElementById('rail-chip-' + kind);
    if (collapse) {
      panel.style.display = 'none';
      var rz = document.getElementById(d.resizer); if (rz) rz.style.display = 'none';
      if (btn) btn.style.display = 'none';
      if (!chip) {
        chip = document.createElement('button');
        chip.id = 'rail-chip-' + kind;
        chip.type = 'button';
        chip.className = 'rail-chip';
        document.body.appendChild(chip);
        this.bindChip(chip, kind);
      }
      this.labelChip(chip, kind);
      this.placeChip(chip, kind);
      chip.style.display = 'inline-flex';
      UI.status(tr('rail.collapsed', { name:tr(d.name), chip:tr(d.label) }));
    } else {
      panel.style.display = '';
      var rz2 = document.getElementById(d.resizer); if (rz2) rz2.style.display = '';
      if (btn) btn.style.display = '';
      if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
      UI.status(tr('rail.expanded', { name:tr(d.name) }));
    }
  },
  labelChip: function (chip, kind) {
    var d = this.defs[kind];
    chip.textContent = tr(d.label);
    chip.title = tr(d.expand);
    chip.setAttribute('aria-label', tr(d.expand));
  },
  /* 界面语言切换后刷新已存在的悬浮 chip 文字 */
  relabel: function () {
    var self = this;
    Object.keys(this.defs).forEach(function (kind) {
      var chip = document.getElementById('rail-chip-' + kind);
      if (chip) { self.labelChip(chip, kind); self.placeChip(chip, kind); }
    });
  },
  placeChip: function (chip, kind) {
    var w = chip.offsetWidth || 56, h = chip.offsetHeight || 26;
    var saved = this.pos[kind], x, y;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      x = saved.x; y = saved.y;
    } else if (this.defs[kind].side === 'left') {
      x = 8; y = 64;
    } else {
      x = Math.max(8, window.innerWidth - w - 8); y = 64;
    }
    x = clamp(x, 0, Math.max(0, window.innerWidth - w));
    y = clamp(y, 0, Math.max(0, window.innerHeight - h));
    chip.style.left = x + 'px'; chip.style.top = y + 'px';
  },
  bindChip: function (chip, kind) {
    var self = this;
    var drag = null;   /* { ox, oy, moved } */
    chip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var r = chip.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false };
      var move = function (ev) {
        if (!drag) return;
        if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 4) drag.moved = true;
        if (!drag.moved) return;
        chip.style.left = clamp(ev.clientX - drag.ox, 0, Math.max(0, window.innerWidth - chip.offsetWidth)) + 'px';
        chip.style.top = clamp(ev.clientY - drag.oy, 0, Math.max(0, window.innerHeight - chip.offsetHeight)) + 'px';
      };
      var up = function () {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (drag && drag.moved) {
          self.pos[kind] = { x: Math.round(parseFloat(chip.style.left) || 0), y: Math.round(parseFloat(chip.style.top) || 0) };
          self.save();
          self._suppressClick = true;   /* 拖拽结束的 click 不触发展开 */
        }
        drag = null;
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      e.preventDefault();
    });
    chip.addEventListener('click', function () {
      if (self._suppressClick) { self._suppressClick = false; return; }
      self.toggle(kind, false);
    });
  },
  init: function () {
    this.load();
    var self = this;
    var lc = document.getElementById('lib-collapse');
    if (lc) lc.addEventListener('click', function () { self.toggle('lib', true); });
    var ic = document.getElementById('insp-collapse');
    if (ic) ic.addEventListener('click', function () { self.toggle('insp', true); });
  }
};
