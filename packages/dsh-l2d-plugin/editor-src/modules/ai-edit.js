/* =========================================================================
   AiEdit：底栏「AI 编辑」标签页 + 可替换的接口适配层（契约：docs/nodegraph/AI-EDIT-API.md v1）。
   - AiEditAdapter 是前端唯一的接口调用点：
       POST /dsh-l2d/api/nodegraph/ai-edit    {graph, instruction, lang}
         200 {ok, ops, explanation, warnings, baseHash, valid, previewHash}
         503 ai-unavailable（未配置 / 不可用） · 502 ai-failed / ai-bad-response（失败，可重试）
       POST /dsh-l2d/api/nodegraph/apply-ops  {graph, ops, baseHash}（纯预演，不写文件）
         200 {ok, graph, valid, applied, errors[{opIndex, op, reason, message}], warnings, hash}
         409 stale-graph
     graph = 设计层 {nodes, edges, viewport}（与导出 meta.editor 同形）。前端不计算 graphHash、不自行应用 ops。
   - 接口不存在（file://、网络错误、404/501）→「接口未就绪」
   - 防过期：生成时记下画布序列化快照，确认时先本地比对；后端 409 再兜底
   - 撤销：应用前保存完整导出快照，撤销即恢复该快照
   - 预览：每条 op 译成人话，并在画布上高亮会变动的节点；reason code 原样保留为次要信息
   - 测试可替换 AiEditAdapter.fetch（selftest 用 mock，不发真实请求）
   ========================================================================= */
var AiEditAdapter = {
  EDIT_URL: '/dsh-l2d/api/nodegraph/ai-edit',
  APPLY_URL: '/dsh-l2d/api/nodegraph/apply-ops',
  fetch: function (url, opts) { return window.fetch(url, opts); },
  /* 结果统一为 { ready, status, data }；ready=false 表示接口本身不存在或不可达 */
  post: function (url, body) {
    var self = this;
    if (location.protocol === 'file:' && this.fetch === AiEditAdapter._nativeFetch) return Promise.resolve({ ready:false, status:0, data:{} });
    return Promise.resolve().then(function () {
      return self.fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
    }).then(function (res) {
      if (!res || res.status === 404 || res.status === 501) return { ready:false, status:res ? res.status : 0, data:{} };
      return res.json().then(function (data) { return { ready:true, status:res.status, data:data || {} }; },
        function () { return { ready:true, status:res.status, data:{} }; });
    }, function () { return { ready:false, status:0, data:{} }; });
  },
  edit: function (graph, instruction, lang) { return this.post(this.EDIT_URL, { graph:graph, instruction:instruction, lang:lang }); },
  applyOps: function (graph, ops, baseHash) {
    var body = { graph:graph, ops:ops };
    if (baseHash != null) body.baseHash = baseHash;
    return this.post(this.APPLY_URL, body);
  }
};
AiEditAdapter._nativeFetch = AiEditAdapter.fetch;

var AiEdit = {
  state: 'idle',        /* idle | loading | proposal | applying | applied | notready | unavailable | failed | error */
  proposal: null,       /* { ops, explanation, warnings, baseHash, valid, snapshot, errors:{opIndex:[...]} } */
  undoSnapshot: null,
  message: '', code: '', lastWarnings: [],
  touched: null,
  LANGS: { 'zh-CN':'zh-CN', en:'en', ja:'ja' },
  init: function () {
    var self = this;
    var send = document.getElementById('ai-send');
    if (send) send.addEventListener('click', function () { self.generate(); });
    var box = document.getElementById('ai-result');
    if (box) box.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-ai]') : null;
      if (!b) return;
      var act = b.getAttribute('data-ai');
      if (act === 'apply') self.confirm();
      else if (act === 'discard') { self.proposal = null; self.highlight(null); self.set('idle'); }
      else if (act === 'undo') self.undo();
      else if (act === 'retry') self.generate();
    });
    var input = document.getElementById('ai-input');
    if (input) input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); self.generate(); }
    });
    this.render();
  },
  /* 设计层图：与导出 meta.editor 同形，只取 nodes / edges / viewport */
  designGraph: function (text) {
    var ed = JSON.parse(text || Serializer.exportText()).meta.editor;
    return { nodes:ed.nodes, edges:ed.edges, viewport:ed.viewport };
  },
  set: function (state, msg, code) { this.state = state; this.message = msg || ''; this.code = code || ''; this.render(); },
  reasonText: function (code) { return I18n.has('ai.reason.' + code) ? tr('ai.reason.' + code) : String(code || ''); },
  warnText: function (w) {
    if (w && typeof w === 'object') {
      var code = w.reason || w.code || '';
      return { text:(code && I18n.has('ai.reason.' + code) ? tr('ai.reason.' + code) : String(w.message || code)) + (w.id || w.value ? ' · ' + String(w.id || w.value) : ''), code:code };
    }
    return { text:String(w), code:'' };
  },
  generate: function () {
    var self = this, input = document.getElementById('ai-input');
    var text = input ? input.value.trim() : '';
    if (!text) { this.set('error', tr('ai.empty')); return Promise.resolve(); }
    var snapshot = Serializer.exportText();
    this.proposal = null; this.highlight(null);
    this.set('loading', tr('ai.loading'));
    return AiEditAdapter.edit(this.designGraph(snapshot), text, this.LANGS[I18n.lang] || 'zh-CN').then(function (r) {
      var d = r.data || {};
      if (!r.ready) { self.set('notready', tr('ai.notReady')); return; }
      if (r.status === 503) { self.set('unavailable', tr('ai.unavailable'), d.reason || 'ai-unavailable'); return; }
      if (r.status >= 500 || r.status >= 400 && r.status !== 409) { self.set('failed', tr('ai.failed'), d.reason || ('http-' + r.status)); return; }
      if (!Array.isArray(d.ops)) { self.set('failed', tr('ai.failed'), d.reason || 'ai-bad-response'); return; }
      self.proposal = { ops:d.ops, explanation:String(d.explanation || ''), warnings:Array.isArray(d.warnings) ? d.warnings : [],
        baseHash:d.baseHash == null ? null : d.baseHash, valid:d.valid !== false, snapshot:snapshot, errors:{} };
      self.highlight(d.ops);
      self.set('proposal', d.valid === false ? tr('ai.previewInvalid') : '');
    });
  },
  confirm: function () {
    var self = this, p = this.proposal;
    if (!p) return Promise.resolve();
    var now = Serializer.exportText();
    if (now !== p.snapshot) { this.set('proposal', tr('ai.stale'), 'stale-graph'); return Promise.resolve(); }
    this.set('applying', tr('ai.applying'));
    return AiEditAdapter.applyOps(this.designGraph(now), p.ops, p.baseHash).then(function (r) {
      var d = r.data || {};
      if (!r.ready) { self.set('proposal', tr('ai.notReady')); return; }
      if (r.status === 409) { self.set('proposal', tr('ai.stale'), d.reason || 'stale-graph'); return; }
      if (r.status !== 200) { self.set('proposal', tr('ai.applyFailed'), d.reason || ('http-' + r.status)); return; }
      if (!d.valid || !d.graph) {
        p.errors = {};
        (Array.isArray(d.errors) ? d.errors : []).forEach(function (e) {
          var k = typeof e.opIndex === 'number' ? e.opIndex : -1;
          (p.errors[k] = p.errors[k] || []).push(e);
        });
        self.set('proposal', tr('ai.invalid', { n:(d.errors || []).length }), 'graph-invalid'); return;
      }
      if (Serializer.exportText() !== p.snapshot) { self.set('proposal', tr('ai.stale'), 'stale-graph'); return; }
      self.undoSnapshot = now;
      self.lastWarnings = Array.isArray(d.warnings) ? d.warnings : [];
      Graph.restore(Serializer.scrub({ nodes:d.graph.nodes, edges:d.graph.edges, viewport:Graph.viewport }));
      Cache.invalidate(); Runtime.stop();
      self.proposal = null; self.highlight(null);
      UI.afterImport();
      self.set('applied', tr('ai.applied', { n:p.ops.length }));
    });
  },
  undo: function () {
    if (!this.undoSnapshot) return;
    var res = Serializer.import(this.undoSnapshot);
    if (res.ok) { this.undoSnapshot = null; this.lastWarnings = []; UI.afterImport(); this.set('idle', tr('ai.undone')); }
  },
  /* 画布高亮：会被删除 / 改参 / 移动 / 连线涉及的现有节点 */
  highlight: function (ops) {
    var s = null;
    if (ops && ops.length) {
      s = new Set();
      ops.forEach(function (op) { if (!op) return; ['id', 'from', 'to'].forEach(function (k) { if (op[k] && Graph.byId(op[k])) s.add(op[k]); }); });
    }
    this.touched = s;
    if (typeof UI !== 'undefined' && UI.nodesEl) UI.renderNodes();
  },
  nodeName: function (id, ops) {
    var n = Graph.byId(id);
    if (n) return n.label;
    for (var i = 0; ops && i < ops.length; i++) if (ops[i] && ops[i].op === 'add_node' && ops[i].id === id) return ops[i].label || NodeDef.typeName(ops[i].type);
    return String(id);
  },
  describe: function (op, ops) {
    if (!op || typeof op !== 'object') return tr('ai.op.unknown', { op:String(op) });
    var nm = function (id) { return AiEdit.nodeName(id, ops); };
    switch (op.op) {
      case 'add_node': {
        var pr = op.props || {};
        var what = pr.name || op.label || '';
        return tr(what ? 'ai.op.add' : 'ai.op.addPlain', { type:NodeDef.typeName(op.type), name:what });
      }
      case 'remove_node': return tr('ai.op.remove', { name:nm(op.id) });
      case 'set_param': return tr('ai.op.set', { name:nm(op.id), key:String(op.key), value:JSON.stringify(op.value) });
      case 'connect': return tr('ai.op.connect', { a:nm(op.from), b:nm(op.to) }) + (op.replace ? ' · ' + tr('ai.op.replace') : '');
      case 'disconnect': return op.edgeId ? tr('ai.op.disconnectEdge', { id:String(op.edgeId) }) : tr('ai.op.disconnect', { a:nm(op.from), b:nm(op.to) });
      case 'move_node': return tr('ai.op.move', { name:nm(op.id), x:op.x, y:op.y });
      default: return tr('ai.op.unknown', { op:String(op.op) });
    }
  },
  render: function () {
    var self = this;
    var st = document.getElementById('ai-status'), box = document.getElementById('ai-result');
    var send = document.getElementById('ai-send');
    if (send) send.disabled = this.state === 'loading' || this.state === 'applying';
    var warn = /^(notready|unavailable|failed|error)$/.test(this.state) || (this.state === 'proposal' && this.message);
    if (st) {
      st.innerHTML = esc(this.message || tr('ai.idle')) + (this.code ? ' <code class="ai-code">' + esc(this.code) + '</code>' : '');
      st.className = 'ai-status' + (warn ? ' is-warn' : '') + (this.state === 'applied' ? ' is-ok' : '');
    }
    if (!box) return;
    var p = this.proposal, h = '';
    if (p && (this.state === 'proposal' || this.state === 'applying')) {
      h += '<div class="ai-expl"><b>' + esc(tr('ai.proposal', { n:p.ops.length })) + '</b> ' + esc(p.explanation) + '</div>';
      if (p.ops.length) {
        h += '<ol class="ai-ops">' + p.ops.map(function (op, i) {
          var errs = p.errors[i] || [];
          return '<li class="' + (errs.length ? 'has-err' : '') + '"><span class="desc">' + esc(self.describe(op, p.ops)) + '</span> <code>' + esc(op && op.op || 'op') + '</code>' +
            errs.map(function (e) { return '<div class="ai-err">' + esc(self.reasonText(e.reason)) + ' <code>' + esc(e.reason || '') + '</code></div>'; }).join('') + '</li>';
        }).join('') + '</ol>';
      }
      var rest = p.errors[-1] || [];
      if (rest.length) h += '<ul class="ai-warn">' + rest.map(function (e) { return '<li>' + esc(self.reasonText(e.reason)) + ' <code>' + esc(e.reason || '') + '</code></li>'; }).join('') + '</ul>';
      if (p.warnings.length) h += '<ul class="ai-warn">' + p.warnings.map(function (w) { var t = self.warnText(w); return '<li>' + esc(t.text) + (t.code ? ' <code>' + esc(t.code) + '</code>' : '') + '</li>'; }).join('') + '</ul>';
      h += '<div class="ai-actions"><button class="btn primary" type="button" data-ai="apply"' + (this.state === 'applying' ? ' disabled' : '') + '>' + esc(tr('ai.confirm')) + '</button>' +
        '<button class="btn" type="button" data-ai="discard">' + esc(tr('ai.discard')) + '</button></div>';
    } else if (this.state === 'applied') {
      if (this.lastWarnings.length) h += '<ul class="ai-warn">' + this.lastWarnings.map(function (w) { var t = self.warnText(w); return '<li>' + esc(t.text) + (t.code ? ' <code>' + esc(t.code) + '</code>' : '') + '</li>'; }).join('') + '</ul>';
      if (this.undoSnapshot) h += '<div class="ai-actions"><button class="btn" type="button" data-ai="undo">' + esc(tr('ai.undo')) + '</button></div>';
    } else if (this.state === 'failed') {
      h += '<div class="ai-actions"><button class="btn" type="button" data-ai="retry">' + esc(tr('ai.retry')) + '</button></div>';
    } else if (this.state === 'unavailable') {
      h += '<p class="ai-empty">' + esc(tr('ai.unavailableHelp')) + '</p>';
    }
    box.innerHTML = h;
    box.hidden = !h;
    if (typeof HintBar !== 'undefined') HintBar.measure();
  }
};
