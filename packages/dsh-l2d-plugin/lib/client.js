window.__ModuleLoader__.load({
  id: 'dsh-l2d',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /**
     * P1 客户端入口（隔离验证中）。
     *
     * 关键策略：apply 里**不抛异常**。上一轮真机实验里，抛错的客户端入口会把
     * 整个 Web UI 打进错误页；这里 catch 之后把错误写到 window.__L2D_CLIENT_ERROR__，
     * 由 webServer 注入的 overlay 通过 get_state 诊断字段回读，页面上看不到任何异常。
     */
    const inject = ['slots'];

    function apply(ctx) {
      try {
        const slots = ctx.slots;
        if (!slots) {
          window.__L2D_CLIENT_ERROR__ = 'no ctx.slots service (inject=' + JSON.stringify(inject) + ')';
          return;
        }
        if (typeof slots.register !== 'function') {
          window.__L2D_CLIENT_ERROR__ = 'ctx.slots.register is ' + typeof slots.register + '; keys=' + Object.keys(slots).slice(0, 12).join(',');
          return;
        }
        const React = require('react');
        slots.register({ name: 'shell.overlay', id: 'dsh-l2d' }, function L2DSlotProbe() {
          return React.createElement(
            'div',
            {
              'data-dsh-l2d-slot': 'overlay',
              style: {
                position: 'fixed', left: '50%', top: '12px', transform: 'translateX(-50%)',
                zIndex: 2147483647, padding: '6px 14px', borderRadius: '999px',
                background: '#1d4ed8', color: '#fff',
                font: '600 14px/1.4 system-ui, sans-serif',
                border: '2px solid #93c5fd',
              },
            },
            'L2D slot ok · ' + new Date().toLocaleTimeString(),
          );
        });
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
