window.__ModuleLoader__.load({
  id: 'dsh-l2d',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /**
     * P1 客户端入口 —— 槽位注册已停用（2026-11-07，用户裁决）。
     *
     * 原实现：向宿主 `shell.overlay` 槽位注册一个 fixed 右下角 320×480 的
     * iframe（src=/dsh-l2d/test.html，棋盘格渲染自检页），作为 P1 隔离验证期的
     * 临时「模型调试窗口」。overlay.js（webserver/index-inject 脚本注入）成为
     * 正式通道后，这个带边框的面板被用户当成调试窗口要求移除——页内模型
     * 一律走 overlay 的透明浮层，不再有独立面板形态。
     *
     * 保留 no-op 存根而非删除文件：ModuleLoader 仍会加载本入口，保持加载成功
     * （不 404、不污染宿主控制台），但不再注册任何槽位、不渲染任何 DOM。
     * 测试面板入口保留在设置面板 → 参数监视台（settings.html → /dsh-l2d/test.html）。
     *
     * 关键策略不变：apply 里**不抛异常**，错误写 window.__L2D_CLIENT_ERROR__
     * 供 get_state 诊断字段回读，页面上看不到任何异常。
     */
    const inject = ['slots'];

    function apply(ctx) {
      try {
        // no-op：不再注册 shell.overlay 槽位（调试窗口已按用户裁决移除）。
        window.__L2D_CLIENT_OK__ = true;
      } catch (err) {
        window.__L2D_CLIENT_ERROR__ = String((err && err.stack) || err);
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
