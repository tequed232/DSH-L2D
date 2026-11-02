/**
 * dsh-l2d pet 窗 preload（沙箱内 CJS，只用 contextBridge / ipcRenderer）。
 * 暴露面收敛为 3 个方法（proposals/pet-window-feasibility.md A5）：
 *   onCursor(fn)  主进程光标轮询推送：{x,y}=窗口内坐标；null=光标在窗外
 *   reportHit(hit) 页面 postrender alpha 命中结果（布尔）
 *   drag(phase)   拖动起止 'start' | 'end'（移动由主进程按光标增量完成）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('l2dPet', {
  onCursor: (fn) => {
    const handler = (_e, v) => {
      try {
        fn(v);
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on('l2d-pet:cursor', handler);
    return () => {
      try {
        ipcRenderer.removeListener('l2d-pet:cursor', handler);
      } catch {
        /* ignore */
      }
    };
  },
  reportHit: (hit) => {
    try {
      ipcRenderer.send('l2d-pet:hit', hit === true);
    } catch {
      /* ignore */
    }
  },
  drag: (phase) => {
    try {
      ipcRenderer.send('l2d-pet:drag', { phase: phase === 'start' ? 'start' : 'end' });
    } catch {
      /* ignore */
    }
  },
});
