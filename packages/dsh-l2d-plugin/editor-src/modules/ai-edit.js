/* =========================================================================
   AiEdit：底栏「AI 编辑」标签页 + 可替换的接口适配层。
   - 适配层 AiEditAdapter 是前端唯一的接口调用点（接口格式以后端文档为准）：
       POST /dsh-l2d/api/nodegraph/ai-edit    {graph, instruction, lang} → {ops, explanation, warnings, baseHash}
       POST /dsh-l2d/api/nodegraph/apply-ops  {graph, ops, baseHash?}    → {graph, valid, errors}
     graph = 当前导出文档（Serializer.exportText 的 JSON），前端不自行应用 ops。
   - 接口不可达（file://、网络错误、404/501/503）→ 显示「接口未就绪」，不改画布
   - 防过期：生成时记下画布序列化快照；确认时画布已变化 → 提示重新生成，不应用
   - 撤销：应用前保存原文档快照，撤销即恢复该快照
   - 测试可替换 AiEditAdapter.fetch（selftest 用 mock，不发真实请求）
   ========================================================================= */
var AiEditAdapter = {
  EDIT_URL: '/dsh-l2d/api/nodegraph/ai-edit',
  APPLY_URL: '/dsh-l2d/api/nodegraph/apply-ops',
  fetch: function (url, opts) { return window.fetch(url, opts); },
  post: function (url, body) {
    var self = this;
    if (location.protocol === 'file:') return Promise.resolve({ ready:false });
    return Promise.resolve().then(function () {
      return self.fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
    }).then(function (res) {
      if (!res || res.status === 404 || res.status === 501 || res.status === 503) return { ready:false };
      return res.json().then(function (data) { return { ready:true, ok:!!res.ok, status:res.status, data:data || {} }; },
        function () { return { ready:true, ok:false, status:res.status, data:{} }; });
    }, function () { return { ready:false }; });
  },
  edit: function (graph, instruction, lang) { return this.post(this.EDIT_URL, { graph:graph, instruction:instruction, lang:lang }); },
  applyOps: function (graph, ops, baseHash) {
    var body = { graph:graph, ops:ops };
    if (baseHash != null) body.baseHash = baseHash;
    return this.post(this.APPLY_URL, body);
  }
};
var AiEdit = {
  state: 'idle',         /* idle | loading | proposal | applying | applied | error */
  proposal: null,        /* { ops, explanation, warnings, baseHash, snapshot } */
  undoSnapshot: null,
  message: '',
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
      else if (act === 'discard') { self.proposal = null; self.set('idle', ''); }
      else if (act === 'undo') self.undo();
    });
    var input = document.getElementById('ai-input');
    if (input) input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); self.generate(); }
    });
    this.render();
  },
  set: function (state, msg) { this.state = state; this.message = msg || ''; this.render(); },
  generate: function () {
    var self = this, input = document.getElementById('ai-input');
    var text = input ? input.value.trim() : '';
    if (!text) { this.set('error', tr('ai.empty')); return Promise.resolve(); }
    var snapshot = Serializer.exportText();
    this.proposal = null;
    this.set('loading', tr('ai.loading'));
    return AiEditAdapter.edit(JSON.parse(snapshot), text, I18n.lang).then(function (r) {
      if (!r.ready) { self.set('error', tr('ai.notReady')); return; }
      var d = r.data;
      if (!r.ok || !Array.isArray(d.ops)) { self.set('error', tr('ai.badReply', { code:r.status })); return; }
      self.proposal = { ops:d.ops, explanation:String(d.explanation || ''), warnings:Array.isArray(d.warnings) ? d.warnings : [],
        baseHash:d.baseHash == null ? null : d.baseHash, snapshot:snapshot };
      self.set('proposal', '');
    });
  },
  confirm: function () {
    var self = this, p = this.proposal;
    if (!p) return Promise.resolve();
    var now = Serializer.exportText();
    if (now !== p.snapshot) { this.set('proposal', tr('ai.stale')); return Promise.resolve(); }
    this.set('applying', tr('ai.applying'));
    return AiEditAdapter.applyOps(JSON.parse(now), p.ops, p.baseHash).then(function (r) {
      if (!r.ready) { self.set('proposal', tr('ai.notReady')); return; }
      var d = r.data;
      if (!d.valid || !d.graph) {
        var errs = Array.isArray(d.errors) && d.errors.length ? d.errors.join('；') : tr('ai.badReply', { code:r.status });
        self.set('proposal', tr('ai.invalid', { errors:errs })); return;
      }
      if (Serializer.exportText() !== p.snapshot) { self.set('proposal', tr('ai.stale')); return; }
      var res = Serializer.import(JSON.stringify(d.graph));
      if (!res.ok) { self.set('proposal', tr('ai.invalid', { errors:res.errors.join('；') })); return; }
      self.undoSnapshot = now;
      self.proposal = null;
      UI.afterImport();
      self.set('applied', tr('ai.applied', { n:p.ops.length }));
    });
  },
  undo: function () {
    if (!this.undoSnapshot) return;
    var res = Serializer.import(this.undoSnapshot);
    if (res.ok) { this.undoSnapshot = null; UI.afterImport(); this.set('idle', tr('ai.undone')); }
  },
  render: function () {
    var st = document.getElementById('ai-status'), box = document.getElementById('ai-result');
    var send = document.getElementById('ai-send');
    if (send) send.disabled = this.state === 'loading' || this.state === 'applying';
    if (st) {
      st.textContent = this.message || tr('ai.idle');
      st.className = 'ai-status' + (this.state === 'error' || /^(proposal)$/.test(this.state) && this.message ? ' is-warn' : '') +
        (this.state === 'applied' ? ' is-ok' : '');
    }
    if (!box) return;
    var p = this.proposal, h = '';
    if (p && (this.state === 'proposal' || this.state === 'applying')) {
      h += '<div class="ai-expl"><b>' + esc(tr('ai.proposal', { n:p.ops.length })) + '</b> ' + esc(p.explanation) + '</div>';
      if (p.ops.length) {
        h += '<ol class="ai-ops">' + p.ops.slice(0, 12).map(function (op) {
          var name = op && (op.op || op.type || op.kind) || 'op';
          var rest = JSON.stringify(op); if (rest.length > 96) rest = rest.slice(0, 95) + '…';
          return '<li><code>' + esc(name) + '</code> <span>' + esc(rest) + '</span></li>';
        }).join('') + (p.ops.length > 12 ? '<li>…</li>' : '') + '</ol>';
      }
      if (p.warnings.length) h += '<ul class="ai-warn">' + p.warnings.map(function (w) { return '<li>' + esc(String(w)) + '</li>'; }).join('') + '</ul>';
      h += '<div class="ai-actions"><button class="btn primary" type="button" data-ai="apply"' + (this.state === 'applying' ? ' disabled' : '') + '>' + esc(tr('ai.confirm')) + '</button>' +
        '<button class="btn" type="button" data-ai="discard">' + esc(tr('ai.discard')) + '</button></div>';
    } else if (this.undoSnapshot && this.state === 'applied') {
      h += '<div class="ai-actions"><button class="btn" type="button" data-ai="undo">' + esc(tr('ai.undo')) + '</button></div>';
    }
    box.innerHTML = h;
    box.hidden = !h;
    if (typeof HintBar !== 'undefined') HintBar.measure();
  }
};
