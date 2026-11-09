/* =========================================================================
   Combos：用户自定义节点组合事件。多选节点存为可复用组合，节点库一键实例化。
   存储 localStorage 'dsh-mg-combos.v1'；file:// 受限时降级内存（同 Slots 策略）。
   组合是编辑器侧便利层：实例化后展开为普通节点+连线，导出 JSON 语义不变。
   ========================================================================= */
var Combos = {
  KEY: 'dsh-mg-combos.v1',
  available: true,
  memory: [],
  all: function () {
    if (this.available) {
      try {
        var raw = localStorage.getItem(this.KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (err) { this.available = false; }
    }
    return this.memory.slice();
  },
  byName: function (name) {
    var list = this.all();
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return null;
  },
  save: function (combo) {
    var list = this.all().filter(function (c) { return c.name !== combo.name; });
    list.push(combo);
    this.persist(list);
  },
  del: function (name) {
    this.persist(this.all().filter(function (c) { return c.name !== name; }));
  },
  persist: function (list) {
    if (this.available) {
      try { localStorage.setItem(this.KEY, JSON.stringify(list)); return; }
      catch (err) { this.available = false; }
    }
    this.memory = list;
  }
};
