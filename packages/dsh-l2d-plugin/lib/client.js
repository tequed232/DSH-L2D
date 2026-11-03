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
        // 宿主 slot 由 layout 的 root entry 用 children 表声明（shell.overlay 由
        // @deepseek-ai/dsh-client-ui-layout 声明为 { kind:'list', scope:'root' }）。
        // 我们的 apply 可能早于 layout 注册执行，直接 register 会抛
        // `slot "shell.overlay" is not declared`。必须用 slots.inject 等声明就绪：
        // 已声明则同步执行，未声明则在声明提交时执行。
        if (typeof slots.inject !== 'function') {
          window.__L2D_CLIENT_ERROR__ = 'ctx.slots.inject is ' + typeof slots.inject + '; keys=' + Object.keys(slots).slice(0, 12).join(',');
          return;
        }
        const React = require('react');
        // inject 回调可能跑在 layout 的 register 调用栈里（宿主 fiber），
        // 这里绝不能抛异常，否则会把宿主 entry 一起拖垮。
        slots.inject('shell.overlay', function () {
          try {
            slots.register({ name: 'shell.overlay', id: 'dsh-l2d' }, function L2DSlotHost() {
              return React.createElement('iframe', {
                src: '/dsh-l2d/test.html',
                'data-dsh-l2d-slot': 'overlay',
                title: 'dsh-l2d avatar',
                style: {
                  position: 'fixed', right: '24px', bottom: '24px',
                  width: '320px', height: '480px',
                  zIndex: 2147483646,
                  border: '1px solid rgba(147, 197, 253, 0.45)',
                  borderRadius: '16px',
                  background: 'transparent',
                },
              });
            });
            window.__L2D_CLIENT_OK__ = true;
          } catch (err) {
            window.__L2D_CLIENT_ERROR__ = String((err && err.stack) || err);
          }
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
