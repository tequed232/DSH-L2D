# Live2D 配饰面板 · 源码分享

一套给 Electron + pixi-live2d-display 用的配饰开关面板。
勾选就开、取消就关，支持 140+ 部件，支持「语义反转」（比如模型参数叫「脱鞋」，面板上要显示成「鞋子」）。

写完跑通过，坑都写在最后面。

---

## 它长什么样

一个 300×620 的独立小窗，置顶、无边框：

```
┌──────────────────────────┐
│ 配饰        ↔  👁  —  ✕  │  ← 拖动条 + 穿透/隐藏/最小化/关闭
├──────────────────────────┤
│      [全开]  [全关]       │
│  配饰                     │
│  ☑ 大钢盆          key10  │
│  ☐ 黑框眼镜        key11  │
│  ☑ 脸红            key7   │
│  ...                      │
│  全部部件                 │
│  ☑ Part66          1.00   │  ← 模型里所有部件，按实际透明度显示
│  ☐ Part67          0.00   │
└──────────────────────────┘
```

主窗口在托盘点一下、或者 `Ctrl+Shift+P` 就出来。

---

## 架构（四层，别跳）

```
panel.html + panel.js        ← 面板 UI，只做勾选和显示
        ↓ window.api.*        （preload 暴露的白名单）
panel-preload.js             ← contextBridge，把 IPC 包成普通函数
        ↓ ipcRenderer.invoke
main.js                      ← 主进程：查表、反转、分派
        ↓ runInPage(js)        （win.webContents.executeJavaScript）
renderer.html + app.js       ← 渲染页：真正改模型
```

关键点是**主进程不直接碰模型**。模型活在渲染进程里，主进程只能往那边注入 JS。
所以所有「改模型」的请求最后都变成一句 `executeJavaScript`。

---

## 第一步：分清「部件」和「参数」

这是最容易栽的地方。

Live2D 模型里有两套东西能控制显隐：

| 类型 | API | 例子 | 怎么认 |
|---|---|---|---|
| 部件 Part | `coreModel.setPartOpacityById(id, v)` | `Part66` | ID 是 `Part` + 数字 |
| 参数 Parameter | `coreModel.setParameterValueById(id, v)` | `key7` `Clothes4` `Movement1` | 其他都是 |

**大肥鱼这个模型（DeepSeek 免费公皮）的配饰几乎全是参数，不是部件。**
钢盆、眼镜、尾巴、脸红、鞋子——都是 `key1`~`key13` / `Movement1`~`3` / `Clothes1`~`5`。

一开始以为是部件，调 `setPartOpacityById('key7', 1)`，一点反应都没有，白找了两轮。

判断函数：

```js
function isParamId(id) {
  return /^key\d+$/.test(id) || /^(Movement|Clothes)\d+$/.test(id);
}
```

---

## 第二步：参数要在渲染层的 beforeModelUpdate 里写

**这是最大的坑。**

在 `executeJavaScript` 里直接调 `coreModel.setParameterValueById('key7', 1)`，
屏幕上什么都不变。原因是 Cubism 每帧的更新顺序是：

```
afterMotionUpdate()
  → saveParameters()          ← 存一份当前值
  → expression / eyeblink / physics
  → beforeModelUpdate()       ← 你只能在这里插
  → coreModel.update()        ← 用参数算出顶点
  → coreModel.loadParameters() ← ★ 把存的那份盖回来
```

最后那步 `loadParameters()` 会把你的修改冲掉。

正确做法：**声明一个「要保持」的表，每帧在 beforeModelUpdate 里盖回去，盖完再 saveParameters。**

```js
window.__jyHeldParams = {};      // 参数
window.__jyHeldParts  = {};      // 部件

model.internalModel.on('beforeModelUpdate', () => {
  const core = model.internalModel.coreModel;

  for (const id in window.__jyHeldParts) {
    try { core.setPartOpacityById(id, window.__jyHeldParts[id]); } catch (e) {}
  }
  for (const id in window.__jyHeldParams) {
    try { core.setParameterValueById(id, window.__jyHeldParams[id]); } catch (e) {}
  }
  // ★ 这一句不能少：把刚设的值存成「基准」，
  //   下一帧 loadParameters() 盖回来的才是你要的值，而不是模型的默认值。
  try { core.saveParameters(); } catch (e) {}
});
```

调用时机也要对。`beforeModelUpdate` 注册必须在模型加载完、绑定好之后。

---

## 第三步：语义反转

模型的参数名不一定符合用户直觉。

这个模型的鞋子参数叫「脱鞋」：`Clothes4 = 1` 表示**脱掉**。

面板上当然要显示成「鞋子 ☑ = 穿着」，所以中间要翻一次：

```js
const INVERT = {};   // { Clothes4: true }
for (const a of ACCESSORY_LIST) if (a.invert) INVERT[a.id] = true;

function pushParts(map) {
  const parts = {}, params = {};
  for (const id in map) {
    const raw = map[id];                       // 面板传来的语义值
    const sent = INVERT[id] ? (1 - raw) : raw; // 送给模型的实际值
    if (isParamId(id)) params[id] = sent; else parts[id] = sent;
    partState[id] = raw;                       // ★ 状态存语义值，不存反转后的
  }
  let js = '(function(){';
  if (Object.keys(parts).length)  js += 'window.__setParts('  + JSON.stringify(parts)  + ');';
  if (Object.keys(params).length) js += 'window.__setParams(' + JSON.stringify(params) + ');';
  js += "return 'ok';})()";
  return runInPage(js);
}
```

**状态存哪一份很关键。** 存语义值，面板刷新时直接读、直接勾；
存反转后的值，面板就会显示「鞋子 ☑」而人其实光着脚——这个 bug 我们真踩到了。

---

## 第四步：面板初始状态必须读真实值

第一版面板是这么写的：

```js
// ✗ 错的
for (const a of list) {
  listAcc.appendChild(makeRow(a.id, a.label, 1));   // 一律当成开
}
```

结果面板一打开所有配饰都是勾选状态，但模型上只开了四项。
用户点一下「关」，反而把它打开了。

正确：

```js
const state = await window.api.getState();   // 主进程里的 partState
for (const a of list) {
  const v = Object.prototype.hasOwnProperty.call(state, a.id) ? state[a.id] : 0;
  listAcc.appendChild(makeRow(a.id, a.label, v));
}
```

`partState` 在主进程里维护，每次 `pushParts` 都更新它。
面板每次打开问一遍，永远显示真值。

---

## 第五步：默认配饰要在模型就绪后再盖

开窗就要穿上裙子、鞋子、尾巴，这个「默认状态」不能一启动就设——
`renderer.html` 里 `Live2DModel.from()` 是异步的，模型没加载完调什么都是空。

而且加载时间不固定（这台机器 8 秒左右）。写死 `setTimeout(3000)` 会扑空。

轮询等就绪：

```js
function applyDefaults() {
  let tried = 0, fired = false;
  const timer = setInterval(async () => {
    tried++;
    const ready = await runInPage('window.__ready === true');
    if (!ready) {
      if (tried > 40) clearInterval(timer);    // 16 秒后放弃
      return;
    }
    if (fired) return;      // ★ 这个标志不能少
    fired = true;           // async 里 clearInterval 追不上重叠的 tick
    clearInterval(timer);
    await pushParts(DEFAULT_PARTS);
  }, 400);
}
```

那个 `fired` 标志：`setInterval` 的回调是 async 的，`clearInterval` 执行时可能已经有下一个 tick 排在队里了。
只用 `clearInterval` 会跑两遍。加个布尔挡住。

---

## 完整源码

### panel.html

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>配饰面板</title>
<style>
  :root { --bg:#14161c; --fg:#e8ecf4; --mute:#8b93a7; --line:#252a36; --acc:#5b8cff; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; height:100%; background:var(--bg); color:var(--fg);
    font: 13px/1.5 "Microsoft YaHei UI","Segoe UI",sans-serif; user-select:none; overflow:hidden; }
  header { -webkit-app-region: drag; display:flex; align-items:center; gap:8px;
    padding:10px 12px; border-bottom:1px solid var(--line); }
  header .title { flex:1; font-weight:600; letter-spacing:.5px; }
  header button { -webkit-app-region: no-drag; width:22px; height:22px; border:0; border-radius:6px;
    background:#1d2230; color:var(--mute); cursor:pointer; font-size:12px; }
  header button:hover { background:#2a3142; color:var(--fg); }
  main { padding:8px 10px 14px; height:calc(100% - 45px); overflow-y:auto; }
  .row { display:flex; align-items:center; gap:8px; padding:5px 6px; border-radius:6px; }
  .row:hover { background:#1a1f2b; }
  .row input { accent-color: var(--acc); width:15px; height:15px; flex:none; }
  .row label { flex:1; cursor:pointer; }
  .row .id { color:var(--mute); font-size:11px; font-family: Consolas, monospace; }
  .sec { margin:12px 0 4px; color:var(--mute); font-size:11px; letter-spacing:1px; }
  .tools { display:flex; gap:6px; padding:6px 6px 2px; }
  .tools button { flex:1; padding:6px; border:1px solid var(--line); border-radius:6px;
    background:#1a1f2b; color:var(--fg); cursor:pointer; font-size:12px; }
  .tools button:hover { border-color:var(--acc); }
  main::-webkit-scrollbar { width:8px; }
  main::-webkit-scrollbar-thumb { background:#2c3342; border-radius:4px; }
</style>
</head>
<body>
<header>
  <span class="title">配饰</span>
  <button id="btnThrough" title="鼠标穿透">↔</button>
  <button id="btnHide" title="隐藏人物">👁</button>
  <button id="btnMin" title="最小化">—</button>
  <button id="btnClose" title="关面板">✕</button>
</header>
<main>
  <div class="tools">
    <button id="allOn">全开</button>
    <button id="allOff">全关</button>
  </div>
  <div class="sec">配饰</div>
  <div id="listAcc"></div>
  <div class="sec">全部部件</div>
  <div id="listAll"></div>
</main>
<script src="panel.js"></script>
</body>
</html>

```

### panel.js

```js
// 面板逻辑：勾选 → IPC → 主进程 → 渲染页 __setParts
const acc = { list: [], state: {} };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function makeRow(id, label, value) {
  const row = el('div', 'row');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = value > 0.5;
  cb.dataset.id = id;
  const lab = el('label', null, label);
  const tag = el('span', 'id', id);
  cb.addEventListener('change', function () { toggle(id, cb.checked ? 1 : 0); });
  lab.addEventListener('click', function () { cb.checked = !cb.checked; toggle(id, cb.checked ? 1 : 0); });
  row.appendChild(cb); row.appendChild(lab); row.appendChild(tag);
  return row;
}

async function toggle(id, v) {
  acc.state[id] = v;
  await window.api.setParts({ [id]: v });
}

async function boot() {
  acc.list = await window.api.accessoryList();
  // 配饰初始状态读主进程缓存，不再一律填 1——之前全填 1 会让「鞋子」显示成勾选但实际是脱鞋
  try { acc.state = (await window.api.getState()) || {}; } catch { acc.state = {}; }
  const listAcc = document.getElementById('listAcc');
  for (const a of acc.list) {
    const v = Object.prototype.hasOwnProperty.call(acc.state, a.id) ? acc.state[a.id] : 0;
    listAcc.appendChild(makeRow(a.id, a.label, v));
  }
  // 全部部件：名字查 cdi3 太麻烦，直接列 ID + 当前透明度
  const all = await window.api.listParts();
  const listAll = document.getElementById('listAll');
  if (all && all.length) {
    for (const pair of all) {
      const id = pair[0], op = pair[1];
      const row = el('div', 'row');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = op > 0.5;
      cb.addEventListener('change', function () { toggle(id, cb.checked ? 1 : 0); });
      row.appendChild(cb);
      row.appendChild(el('label', null, id));
      row.appendChild(el('span', 'id', op.toFixed(2)));
      listAll.appendChild(row);
    }
  } else {
    listAll.appendChild(el('div', 'sec', '模型还没加载好，稍后重开面板'));
  }
  document.getElementById('allOn').onclick = function () {
    const m = {}; for (const a of acc.list) m[a.id] = 1; for (const p of (all||[])) m[p[0]] = 1;
    window.api.setParts(m);
    document.querySelectorAll('input[type=checkbox]').forEach(c => c.checked = true);
  };
  document.getElementById('allOff').onclick = function () {
    const m = {}; for (const a of acc.list) m[a.id] = 0; for (const p of (all||[])) m[p[0]] = 0;
    window.api.setParts(m);
    document.querySelectorAll('input[type=checkbox]').forEach(c => c.checked = false);
  };
  document.getElementById('btnClose').onclick = () => window.api.closePanel();
  document.getElementById('btnMin').onclick = () => window.api.minimizePanel();
  document.getElementById('btnHide').onclick = () => window.api.toggleVisible();
  let through = false;
  document.getElementById('btnThrough').onclick = async function () {
    through = !through;
    await window.api.toggleThrough(through);
    this.style.color = through ? '#5b8cff' : '';
  };
}

boot();

```

### panel-preload.js

```js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  accessoryList: () => ipcRenderer.invoke('parts:accessory-list'),
  listParts: () => ipcRenderer.invoke('parts:list'),
  setParts: (map) => ipcRenderer.invoke('parts:set', map),
  getState: () => ipcRenderer.invoke('parts:state'),
  closePanel: () => ipcRenderer.invoke('panel:close'),
  minimizePanel: () => ipcRenderer.invoke('panel:minimize'),
  toggleVisible: () => ipcRenderer.invoke('win:toggle-visible'),
  toggleThrough: (on) => ipcRenderer.invoke('win:toggle-through', on),
});

```

### main.js 里的相关段落

配饰清单：

```js
// 眼睛看得到的十几样配饰；完整 140+ 项在面板底部「全部部件」里查
const ACCESSORY_LIST = [
  { id: 'key10', label: '大钢盆' },
  { id: 'key11', label: '黑框眼镜' },
  { id: 'key12', label: '单片眼镜' },
  { id: 'key9',  label: '大牙' },
  { id: 'key8',  label: '加载' },
  { id: 'key7',  label: '脸红' },
  { id: 'key6',  label: '屑屑眼' },
  { id: 'key5',  label: '＞＜眼' },
  { id: 'key4',  label: '爱心眼' },
  { id: 'key3',  label: '圈圈眼' },
  { id: 'key2',  label: '落泪' },
  { id: 'key13', label: '流冷汗' },
  { id: 'key1',  label: '黑脸' },
  // 自己的模型还有这些（末尾带 invert 的是语义反转项）
  { id: 'Clothes1', label: '长短裙' },
  { id: 'Clothes2', label: '大小变' },
  { id: 'Clothes3', label: '胸口衣服' },
  { id: 'Clothes4', label: '鞋子', invert: true },
  { id: 'Clothes5', label: '尾巴' },
  { id: 'Movement1', label: '抚胸' },
  { id: 'Movement2', label: '竖食指' },
  { id: 'Movement3', label: '狗尾草' },
];
```

分派与反转（见上面「第三步」）：

```js
function isParamId(id) {
  return /^key\d+$/.test(id) || /^(Movement|Clothes)\d+$/.test(id);
}

const INVERT = {};
for (const a of ACCESSORY_LIST) if (a.invert) INVERT[a.id] = true;

function pushParts(map) {
  const parts = {}, params = {};
  for (const id in map) {
    const raw = map[id];
    const sent = INVERT[id] ? (1 - raw) : raw;
    if (isParamId(id)) params[id] = sent; else parts[id] = sent;
    partState[id] = raw;
  }
  let js = '(function(){';
  if (Object.keys(parts).length)  js += 'window.__setParts('  + JSON.stringify(parts)  + ');';
  if (Object.keys(params).length) js += 'window.__setParams(' + JSON.stringify(params) + ');';
  js += "return 'ok';})()";
  return runInPage(js);
}
```

开面板：

```js
function createPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  panel = new BrowserWindow({
    width: 300, height: 620, x: 40, y: 80,
    frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#14161c',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, 'panel-preload.js'),
    },
  });
  panel.loadFile(path.join(__dirname, 'panel.html'));
  panel.on('closed', () => { panel = null; });
}
```

IPC 那几条：

```js
ipcMain.handle('parts:list',          async () => (await runInPage('window.__listParts()')) || []);
ipcMain.handle('parts:set',           async (_e, map) => pushParts(map || {}));
ipcMain.handle('parts:accessory-list', () => ACCESSORY_LIST);
ipcMain.handle('parts:state',          () => partState);
ipcMain.handle('panel:close',          () => { if (panel) panel.close(); });
ipcMain.handle('panel:minimize',       () => { if (panel) panel.minimize(); });
ipcMain.handle('win:toggle-visible',   () => { if (win) win.isVisible() ? win.hide() : win.show(); return true; });
ipcMain.handle('win:toggle-through',   (_e, on) => { if (win) win.setIgnoreMouseEvents(!!on, { forward: true }); return !!on; });
```

默认配饰：

```js
const DEFAULT_PARTS = {
  key1: 0, key2: 0, key3: 0, key4: 0, key5: 0, key6: 0, key7: 0, key8: 0, key9: 0,
  key10: 0, key11: 0, key12: 0, key13: 0,
  Movement1: 0, Movement2: 0, Movement3: 0,
  Clothes1: 1,   // 长短裙
  Clothes2: 0,   // 大小变
  Clothes3: 1,   // 胸口衣服
  Clothes4: 1,   // 鞋子（invert，语义 1 = 穿着）
  Clothes5: 1,   // 尾巴
};
```

### 渲染页的两个全局函数

放在 `app.js` 里，模型加载完就能用：

```js
window.__jyHeldParts  = {};
window.__jyHeldParams = {};

window.__setParts = function (map) {
  Object.assign(window.__jyHeldParts, map);
  return 'ok';
};
window.__setParams = function (map) {
  Object.assign(window.__jyHeldParams, map);
  return 'ok';
};

// 列出所有部件和当前透明度，给面板底部「全部部件」用
window.__listParts = function () {
  const core = window.__jyCore;
  if (!core) return [];
  const P = core._model.parts;
  const out = [];
  for (let i = 0; i < P.ids.length; i++) {
    out.push([P.ids[i], P.opacities[i]]);
  }
  return out;
};
```

---

## 接进你自己的项目要改什么

1. `ACCESSORY_LIST` —— 换成你模型的实际 ID。查 `<模型>.cdi3.json` 的 `Parameters`，或者跑一次 `__listParts()` 看全部。
2. `DEFAULT_PARTS` —— 你要的初始状态。
3. `isParamId()` —— 如果你的模型配饰是 `Part` 开头，这个函数反过来写。
4. 面板里的中文标签 —— 随便改。
5. `runInPage` —— 你的 `executeJavaScript` 包装。

---

## 坑清单

| 现象 | 原因 | 解法 |
|---|---|---|
| 调 setPartOpacityById 没反应 | 配饰是参数不是部件 | 用 `isParamId()` 分流 |
| 调 setParameterValueById 也没反应 | 每帧 `loadParameters()` 盖回来了 | 在 `beforeModelUpdate` 里写，写完 `saveParameters()` |
| 面板一打开全勾上 | 初始值写死成 1 | 读主进程的 `partState` |
| 「鞋子 ☑」但人光着脚 | 状态存了反转后的值 | 状态存语义值，只在发送时反转 |
| 改勾选状态后模型不动 | 默认状态在模型就绪前就设了 | 轮询 `window.__ready` |
| 默认配饰设了两遍 | `setInterval` + async 重叠 | 加 `fired` 布尔 |
| 面板关了再开状态不同步 | 面板是单例但状态在主进程 | `createPanel` 先检查 `panel && !panel.isDestroyed()` |

---

## 鼠标穿透的一个副作用（提一句）

Electron 的 `setIgnoreMouseEvents(true, { forward: true })` 在 33 版实测
**完全转发不了任何事件**：`mousedown` / `mousemove` / `mouseup` 全是 0 次。

所以「穿透状态 + 还能点模型」这件事做不到。我们这个项目最后的做法是：
**穿透关 = 可交互（拖窗口 + 点部位）；穿透开 = 彻底不挡鼠标。**
面板上那个 ↔ 按钮就是切换这个，别指望它两种能力都要。

---

写完跑通过，用起来挺顺。群友有更好的做法欢迎改。
有问题可以问，我们也是踩着坑过来的。
