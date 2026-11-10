/* =========================================================================
   ModelCatalog / ModelSel：按单个模型编辑动作链（目录接口 + 顶栏模型选择器）。
   契约（与后端对齐）：
     GET /dsh-l2d/api/nodegraph/catalog          → {ok, models:[...]}        模型清单（选择器数据源）
     GET /dsh-l2d/api/nodegraph/catalog?model=X  → {ok, 动作组, 表情, 参数, forms}
                                                   （兼容 motions/expressions/params 英文键）
     GET /dsh-l2d/api/nodegraph/graph?model=X    → {ok, graphs:[{name, modelId, ...}]}  动作链列表
   - 接口未就绪（file:// / 网络错误 / 404 / 501 / 空数据）→ 内置 mock 示例数据（含 demo-model），
     ModelCatalog.useMock 置 true，选择器加虚线边框并在 title/Toast 标注。
   - selftest 可整体替换 ModelCatalog.fetch（不发真实请求）。
   - ModelSel.current = 工作区当前模型；切换模型只换「工作区」（选择器 + 动作链列表 +
     下拉选项数据源），绝不偷偷改当前图的 Binding（绑定只在显式操作时改动）。
   - 新建动作链（Demo.load）默认 bindingMode:'strict' + modelId=当前选中模型。
   ========================================================================= */
function mgToArray(v) {
  return Array.isArray(v) ? v.filter(function (x) { return x != null; }).map(String) : [];
}

var ModelCatalog = {
  CATALOG_URL: '/dsh-l2d/api/nodegraph/catalog',
  LIST_URL: '/dsh-l2d/api/nodegraph/graph',
  fetch: function (url, opts) { return window.fetch(url, opts); },
  useMock: false,
  /* mock 数据源开关：true（默认）时接口未就绪也用内置 mock ID 清单渲染下拉（便于演示/取证）；
     false 时接口未就绪 → 清单为空 → 检查器退回手动输入 + 「该模型暂无 ID 清单」提示。
     selftest / 后端联调时可整体替换 ModelCatalog.fetch 或切换此开关。 */
  MOCK_CATALOGS: true,
  models: [],
  cache: {},         /* model → {expressions, motions, params, forms, mock} */
  graphsCache: {},   /* model → {graphs:[...], mock} */
  MOCK: {
    /* mock 示例数据一律用中性名 demo-model（真实当前模型 ID 由宿主注入时经 ?model= 传入）。
       选项取值均在中西部校验白名单 Capability 内，保证 demo 图校验通过；
       demo-model-b 与 demo-model 清单不同，用于演示「清单外标红」。 */
    models: ['demo-model', 'demo-model-b'],
    catalogs: {
      'demo-model': {
        expressions: ['兔牙', '脸红', '爱心眼', '流泪'],
        motions: ['竖手指打开', '竖手指关闭', '抚胸手打开', '抚胸手关闭'],
        params: ['ParamMouthOpenY', 'ParamEyeLOpen', 'ParamBodyAngleX', 'ParamAngleX'],
        forms: ['rest', 'finger', 'grass', 'chest']
      },
      'demo-model-b': {
        expressions: ['加载', '圈圈眼', '黑脸'],
        motions: ['狗尾巴草打开', '狗尾巴草关闭'],
        params: ['ParamMouthOpenY', 'ParamHairFront'],
        forms: ['rest', 'finger']
      }
    },
    graphs: {
      'demo-model': [
        { name: '挥手打招呼', modelId: 'demo-model', steps: 3 },
        { name: '点头回应', modelId: 'demo-model', steps: 4 }
      ],
      'demo-model-b': [
        { name: '加载演出', modelId: 'demo-model-b', steps: 2 }
      ]
    }
  },
  isFile: function () { return location.protocol === 'file:'; },
  /* 结果统一为 { ready, status, data }；ready=false 表示接口不存在或不可达 */
  getJSON: function (url) {
    var self = this;
    if (this.isFile() && this.fetch === this._nativeFetch) return Promise.resolve({ ready:false, status:0, data:{} });
    return Promise.resolve().then(function () {
      return self.fetch(url);
    }).then(function (res) {
      if (!res || res.status === 404 || res.status === 501) return { ready:false, status:res ? res.status : 0, data:{} };
      return res.json().then(function (d) { return { ready:true, status:res.status, data:d || {} }; },
        function () { return { ready:true, status:res.status, data:{} }; });
    }, function () { return { ready:false, status:0, data:{} }; });
  },
  mockCatalog: function (model) {
    var c = this.MOCK.catalogs[model] || {};
    return {
      expressions: mgToArray(c.expressions), motions: mgToArray(c.motions),
      params: mgToArray(c.params), forms: mgToArray(c.forms), mock: true
    };
  },
  /* 某模型的 ID 清单（动作组 / 表情 / 参数 / forms）；结果缓存 */
  get: function (model) {
    if (!model) return Promise.resolve(null);
    var self = this;
    return this.getJSON(this.CATALOG_URL + '?model=' + encodeURIComponent(model)).then(function (r) {
      var d = r.ready ? r.data : {};
      var cat = {
        expressions: mgToArray(d.expressions || d['表情']),
        motions: mgToArray(d.motions || d['动作组']),
        params: mgToArray(d.params || d['参数']),
        forms: mgToArray(d.forms)
      };
      var has = cat.expressions.length || cat.motions.length || cat.params.length || cat.forms.length;
      if (!r.ready || !has) {
        self.useMock = true;
        /* MOCK_CATALOGS=false 时保持空清单：options() 返回 null → 检查器退回手动输入 */
        cat = self.MOCK_CATALOGS ? self.mockCatalog(model)
          : { expressions:[], motions:[], params:[], forms:[], mock:true };
      }
      else cat.mock = false;
      self.cache[model] = cat;
      return cat;
    });
  },
  /* 服务端动作链列表（?model= 过滤）；结果缓存。条目保留对象形状（{name, modelId, ...}） */
  listGraphs: function (model) {
    var self = this;
    return this.getJSON(this.LIST_URL + '?model=' + encodeURIComponent(model)).then(function (r) {
      var d = r.ready ? r.data : {};
      var raw = d.graphs || d.list || d['动作链'];
      var g = Array.isArray(raw) ? raw.filter(function (x) { return x != null; }) : [];
      /* mock 标记必须在填充 mock 数据之前判定，否则 mock 条目会被当成真实数据 */
      var fellBack = !r.ready || !g.length;
      if (fellBack) { self.useMock = true; g = (self.MOCK.graphs[model] || []).slice(); }
      var graphs = g.map(function (x) { return typeof x === 'string' ? { name:x } : x; });
      self.graphsCache[model] = { graphs:graphs, mock:fellBack };
      return self.graphsCache[model];
    });
  },
  /* 模型清单（选择器数据源）；接口未就绪 → mock */
  refreshModels: function () {
    var self = this;
    return this.getJSON(this.CATALOG_URL).then(function (r) {
      var d = r.ready ? r.data : {};
      var m = mgToArray(d.models);
      if (!r.ready || !m.length) { self.useMock = true; m = self.MOCK.models.slice(); }
      self.models = m;
      if (self.models.indexOf(ModelSel.current) < 0) self.models.unshift(ModelSel.current);
      return self.models;
    });
  },
  /* 同步取缓存（渲染检查器用，不发请求） */
  data: function (model) { return this.cache[model || ModelSel.current] || null; },
  options: function (kind, model) {
    var c = this.data(model);
    return c && c[kind] && c[kind].length ? c[kind] : null;
  },
  /* 检查器名称类字段构造：有清单 → select（清单外值标红）；没清单 → 手动输入 + 提示 */
  nameField: function (kind, val, base) {
    var list = this.options(kind);
    if (!list) {
      var f = {}; for (var k in base) f[k] = base[k];
      f.kind = 'text'; f.hint = tr('field.noCatalog');
      return f;
    }
    var out = !!val && list.indexOf(String(val)) < 0;
    var f2 = {}; for (var k2 in base) f2[k2] = base[k2];
    f2.kind = 'select'; f2.options = list; f2.outOfList = out;
    return f2;
  },
  /* 参数清单 → modelWhitelist 输入框的 datalist */
  renderParams: function () {
    var list = this.options('params');
    var el = document.getElementById('catalog-params');
    if (!list) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) { el = document.createElement('datalist'); el.id = 'catalog-params'; document.body.appendChild(el); }
    el.innerHTML = list.map(function (p) { return '<option value="' + esc(p) + '">'; }).join('');
  },
  /* 槽位弹窗里的「服务端动作链」区渲染（缓存优先，未取过则异步拉取后重渲染） */
  renderRemoteList: function (el) {
    if (!el) return;
    var m = ModelSel.current, g = ModelCatalog.graphsCache[m];
    if (!g) {
      el.innerHTML = '<div class="hint">' + esc(tr('slots.remoteLoading')) + '</div>';
      ModelCatalog.listGraphs(m).then(function () { ModelCatalog.renderRemoteList(el); });
      return;
    }
    if (!g.graphs.length) { el.innerHTML = '<div class="hint">' + esc(tr('slots.remoteNone')) + '</div>'; return; }
    el.innerHTML = '<div class="hint' + (g.mock ? ' is-out' : '') + '">' +
      esc(g.mock ? tr('slots.remoteFail') : tr('slots.remoteCount', { n:g.graphs.length })) + '</div>' +
      g.graphs.map(function (x) {
        return '<div class="slot-row"><span class="sn">' + esc(x.name || x.id || '—') + '</span><span class="sd">' +
          esc(x.modelId || m) + (g.mock ? ' · ' + esc(tr('slots.remoteMock')) : '') + '</span></div>';
      }).join('');
  }
};

var ModelSel = {
  DEFAULT: 'demo-model',
  current: 'demo-model',
  /* 启动同步部分：URL ?model= > 默认 demo-model；Binding.modelId 为空时由当前模型填充 */
  init: function () {
    var q = '';
    try { q = new URLSearchParams(window.location.search).get('model') || ''; } catch (e) {}
    if (q) this.current = q;
    if (!Binding.modelId) Binding.modelId = this.current;
    var self = this, sel = document.getElementById('model-select');
    if (sel) sel.addEventListener('change', function (e) { self.switchTo(e.target.value); });
    this.render(); this.sync();
  },
  /* 异步部分：拉模型清单 + 当前模型目录 → 渲染选择器与检查器 */
  loadCatalogs: function () {
    var self = this;
    return ModelCatalog.refreshModels().then(function () {
      self.render(); self.sync();
      if (ModelCatalog.useMock && typeof UI !== 'undefined' && UI.toast) UI.toast(tr('model.mockToast'));
      return ModelCatalog.get(self.current);
    }).then(function () {
      ModelCatalog.renderParams();
      if (typeof UI !== 'undefined' && UI.renderInspector) UI.renderInspector();
    }).catch(function () {});
  },
  render: function () {
    var sel = document.getElementById('model-select');
    if (!sel) return;
    var list = ModelCatalog.models.length ? ModelCatalog.models : [this.current];
    sel.innerHTML = list.map(function (m) {
      return '<option value="' + esc(m) + '"' + (m === ModelSel.current ? ' selected' : '') + '>' + esc(m) + '</option>';
    }).join('');
    sel.classList.toggle('is-mock', !!ModelCatalog.useMock);
    sel.title = ModelCatalog.useMock ? tr('model.mockTitle') : tr('model.title');
  },
  sync: function () {
    var sel = document.getElementById('model-select');
    if (sel && sel.value !== this.current) sel.value = this.current;
  },
  /* 切换工作区模型：更新选择器 + 动作链列表 + 下拉数据源；不动当前图绑定 */
  switchTo: function (m) {
    if (!m || m === this.current) { this.sync(); return Promise.resolve(ModelCatalog.graphsCache[m] || null); }
    this.current = m;
    this.sync();
    ModelCatalog.get(m).then(function () {
      ModelCatalog.renderParams();
      if (typeof UI !== 'undefined' && UI.renderInspector) UI.renderInspector();
    });
    return ModelCatalog.listGraphs(m).then(function (r) {
      ModelSel.render();
      var rl = document.getElementById('remote-graph-list');
      if (rl) ModelCatalog.renderRemoteList(rl);
      if (typeof UI !== 'undefined' && UI.toast) {
        if (r && r.graphs && r.graphs.length && !r.mock) UI.toast(tr('model.switched', { m:m, n:r.graphs.length }), 'ok');
        else UI.toast(tr('model.switchFail', { m:m }));
      }
      return r;
    });
  },
  /* selftest 用：在（可能被替换的）fetch 下重新发现目录 */
  reload: function () {
    ModelCatalog.cache = {}; ModelCatalog.graphsCache = {}; ModelCatalog.models = []; ModelCatalog.useMock = false;
    var self = this;
    return ModelCatalog.refreshModels().then(function () {
      self.render(); self.sync();
      return ModelCatalog.get(self.current);
    }).then(function () { ModelCatalog.renderParams(); });
  }
};
ModelCatalog._nativeFetch = ModelCatalog.fetch;
