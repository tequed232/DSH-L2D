# Live2D 动作调试台 · 源码分享

把模型的动作量化成数据。拖滑杆 → 看到模型实时反应 → 录下来 → 导出 JSON。
动作交给别人（人或 AI）用数据描述，你不用再靠文字一句句解释「头往左歪一点、眼睛往下看」。

跑通过，坑在最后面。

---

## 它解决什么

传统做 Live2D 动作：调参数、看效果、凭手感，做完就成一个死文件，别人想改只能整个重做。

这套东西的思路：**把动作变成一份可读的数字**。

```json
{
  "duration": 3.0,
  "keyframes": [
    { "t": 0.0, "v": {} },
    { "t": 0.3, "v": { "ParamAngleY": -6, "ParamEyeBallY": -0.3 } },
    { "t": 0.7, "v": { "ParamAngleY": -8, "ParamEyeBallY": -0.45 } },
    { "t": 1.4, "v": { "ParamAngleY": 0 } }
  ]
}
```

「3 秒内低一下头」变成四行数字。改哪一帧、加多快，改数字就行。
拿给 GPT 也能直接生成——参数名和量程都写在文件里，它不用猜。

---

## 界面

```
┌──────────────────────────┬──────────────────┐
│                          │ 录制             │
│                          │  名称 [new-act]  │
│       模型预览            │  时长 [3] 秒     │
│                          │  [● 开始录制] [■] │
│                          │  [导出JSON][送桌宠]│
│                          │                  │
│                          │ 滑杆（21 个）     │
│                          │  头部 3          │
│                          │  眼睛 5          │
│                          │  表情 4          │
│                          │  身体 2          │
│                          │  左臂 4          │
│                          │  右臂 4          │
│                          │                  │
│                          │ 预设             │
├──────────────────────────┴──────────────────┤
│ ▶ 播放 ❚❚ 清空 │ 0 帧 │ 间隔 0.1 │ 0.00s   │
│           时间轴曲线（5 条代表参数）          │
└─────────────────────────────────────────────┘
```

---

## 滑杆表（21 个）

用的是某个 DeepSeek 免费公皮（大肥鱼）的参数。**换模型要改这张表。**

| 组 | 名称 | 参数 ID | 量程 |
|---|---|---|---|
| 头部 | 转头 | `ParamAngleX` | -30 ~ 30 |
| | 抬头 | `ParamAngleY` | -30 ~ 30 |
| | 歪头 | `ParamAngleZ` | -30 ~ 30 |
| 眼睛 | 眼球左右 | `ParamEyeBallX` | -1 ~ 1 |
| | 眼球上下 | `ParamEyeBallY` | -1 ~ 1 |
| | 左眼 | `ParamEyeLOpen` | 0 ~ 1 |
| | 右眼 | `ParamEyeROpen` | 0 ~ 1 |
| 表情 | 左眉 | `ParamBrowLY` | -1 ~ 1 |
| | 右眉 | `ParamBrowRY` | -1 ~ 1 |
| | 张嘴 | `ParamMouthOpenY` | 0 ~ 1 |
| | 嘴角 | `ParamMouthForm` | -1 ~ 1 |
| 身体 | 身体 | `ParamBodyAngleZ` | -10 ~ 10 |
| | 呼吸 | `ParamBreath` | 0 ~ 1 |
| 左臂 | 左大臂 | `Param62` | -1 ~ 1 |
| | 左小臂 | `Param60` | -1 ~ 1 |
| | 左手腕 | `Param61` | -1 ~ 1 |
| | 左透视 | `Param59` | 0 ~ 1 |
| 右臂 | 右大臂 | `Param36` | -1 ~ 1 |
| | 右小臂 | `Param41` | -1 ~ 1 |
| | 右手腕 | `Param42` | -1 ~ 1 |
| | 右透视 | `Param39` | 0 ~ 1 |

最后八个是**编号参数**，不是语义名。这个模型的作者没用 `ParamArmLA` 那套标准名，
而是 `Param36/39/41/42/59/60/61/62`，从 `<模型>.cdi3.json` 里查出来的对应关系：

```
Param62  L 大臂z      Param36  R大臂z
Param60  L小臂 Z      Param41  R小臂 Z
Param61  L手腕 Z      Param42  R手腕 Z
Param59  大臂透视      Param39  大臂透视
```

**换模型必做**：打开 `<模型>.cdi3.json`，里面有 `Parameters` 数组，每项的 `Id` 和 `Name` 就是参数名和中文说明。
照着改 `SLIDERS` 表。

---

## 三个核心设计

### 一、滑杆值每帧盖回去

和配饰面板同一个坑：Cubism 每帧最后会 `loadParameters()`，把你设的值冲掉。

```js
imm.on('beforeModelUpdate', () => {
  let any = false;
  for (const p in state.held) {
    try { core.setParameterValueById(p, state.held[p]); any = true; } catch (e) {}
  }
  if (any) { try { core.saveParameters(); } catch (e) {} }
});
```

`state.held` 是「要每帧写进去的值」。滑杆一动就更新它。

### 二、录制 = 按间隔打点

不是逐帧记（3 秒 60fps 是 180 帧，文件大且没必要）。按 `kfStep` 打关键帧：

```js
function tryRecord() {
  if (!state.recording) return;
  const t = (performance.now() - state.recStart) / 1000;
  if (t > state.recDur) { stopRec(); return; }
  const step = Math.max(0.02, parseFloat($('kfStep').value) || 0.1);
  if (t - state.lastKeyAt < step - 1e-6) return;   // 还没到下一个点
  state.lastKeyAt = t;
  pushFrame(t);
}
```

`tryRecord` 挂在每个滑杆的 `input` 事件上。不动滑杆就不打点，天然稀疏。

默认 0.1 秒。太密文件大，太疏动作糊。

### 三、导出只写「跟默认值不同」的参数

```js
const DEFAULTS = { ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamBreath: 0.42 };

keyframes: state.frames.map(f => {
  const v = {};
  for (const p in f.v) {
    const base = (p in DEFAULTS) ? DEFAULTS[p] : 0;
    if (Math.abs(f.v[p] - base) > 1e-6) v[p] = f.v[p];
  }
  return { t: f.t, v };
})
```

好处：
- 文件小一半以上
- 人读得懂（只看见动了的参数）
- 别人拿到默认值表就知道没写的参数是什么意思

所以 `parameters` 数组是必须的——它告诉读文件的人「这个模型默认值长什么样」。

---

## 完整源码

### package.json

```json
{
  "name": "live2d-tuner",
  "version": "0.1.0",
  "private": true,
  "main": "main.js"
}
```

### main.js

```js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let win = null;

function create() {
  win = new BrowserWindow({
    width: 1360, height: 860,
    minWidth: 1100, minHeight: 700,
    backgroundColor: '#15171c',
    title: '小璃动作调试台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,       // 要跨目录读模型文件，关掉同源限制
    },
  });
  win.loadFile(path.join(__dirname, 'tuner.html'));
  win.once('ready-to-show', () => win.show());
}

ipcMain.handle('save-json', async (_e, { name, data }) => {
  const safe = String(name || 'motion').replace(/[\\/:*?"<>|]/g, '_');
  const out = path.join(__dirname, 'data', safe.endsWith('.json') ? safe : safe + '.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, path: out };
});

ipcMain.handle('save-as', async (_e, { name, text }) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(__dirname, 'data', name || 'motion.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled) return { ok: false };
  fs.writeFileSync(r.filePath, text, 'utf8');
  return { ok: true, path: r.filePath };
});

ipcMain.handle('list-presets', async () => {
  const dir = 'D:/my-live2d/performances';
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => ({
      id: f.replace('.json', ''),
      ...JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')),
    }));
  } catch (e) { return []; }
});

app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());

```

### preload.js

```js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tuner', {
  saveJson: (name, data) => ipcRenderer.invoke('save-json', { name, data }),
  saveAs: (name, text) => ipcRenderer.invoke('save-as', { name, text }),
  listPresets: () => ipcRenderer.invoke('list-presets'),
});

```

### tuner.html

```html
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>小璃动作调试台</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background:#15171c; color:#c9d1e0;
    font:13px/1.5 'Microsoft YaHei', system-ui; overflow:hidden; user-select:none; }
  #app { display:grid; grid-template-columns: 1fr 400px; grid-template-rows: 1fr 190px; height:100%; }

  /* 舞台 */
  #stage { grid-column:1; grid-row:1; position:relative; background:#0e1014;
    border-right:1px solid #23262e; overflow:hidden; }
  #stage canvas { display:block; }
  #hud { position:absolute; left:12px; top:10px; font-size:12px; color:#6b7688;
    background:rgba(14,16,20,.82); padding:5px 10px; border-radius:6px;
    border:1px solid #23262e; pointer-events:none; }
  #hud b { color:#7fb0ff; font-weight:600; }

  /* 右侧滑杆 */
  #panel { grid-column:2; grid-row:1 / span 2; overflow-y:auto; padding:12px 14px 20px; }
  #panel::-webkit-scrollbar { width:8px; }
  #panel::-webkit-scrollbar-thumb { background:#2c313b; border-radius:4px; }
  h3 { margin:16px 0 8px; font-size:12px; color:#7f8a9d; font-weight:600;
    letter-spacing:.06em; text-transform:uppercase; }
  h3:first-child { margin-top:0; }
  .sl { display:grid; grid-template-columns: 68px 1fr 52px; align-items:center;
    gap:8px; margin-bottom:5px; }
  .sl label { font-size:12px; color:#9aa5b8; }
  .sl input[type=range] { width:100%; height:16px; -webkit-appearance:none;
    background:transparent; cursor:pointer; }
  .sl input[type=range]::-webkit-slider-runnable-track {
    height:4px; background:#2b303a; border-radius:2px; }
  .sl input[type=range]::-webkit-slider-thumb {
    -webkit-appearance:none; width:12px; height:12px; border-radius:50%;
    background:#4a8cff; margin-top:-4px; border:1px solid #1a1d24; }
  .sl input[type=range]:hover::-webkit-slider-thumb { background:#6ba0ff; }
  .sl .val { font:11px/1 ui-monospace, Consolas, monospace; color:#63708a;
    text-align:right; }
  .sl.on .val { color:#ffb454; }

  /* 时间轴 */
  #timeline { grid-column:1; grid-row:2; border-top:1px solid #23262e;
    background:#111318; display:flex; flex-direction:column; }
  #tlbar { display:flex; align-items:center; gap:8px; padding:7px 12px;
    border-bottom:1px solid #1c1f26; flex-wrap:wrap; }
  #tlbar .sep { width:1px; height:16px; background:#262b34; }
  button { background:#242933; color:#b8c2d4; border:1px solid #2f3542;
    border-radius:6px; padding:5px 11px; font:12px/1.2 inherit; cursor:pointer; }
  button:hover { background:#2d3440; border-color:#3d4658; }
  button:active { background:#1d2229; }
  button.primary { background:#1d3f6e; border-color:#2f5f9e; color:#bcd9ff; }
  button.primary:hover { background:#245089; }
  button.danger { color:#e08585; }
  button.danger:hover { background:#3a2429; border-color:#5c3339; }
  #tl { flex:1; position:relative; margin:0 12px 10px; background:#0b0d11;
    border:1px solid #1c1f26; border-radius:6px; overflow:hidden; }
  #tl canvas { display:block; width:100%; height:100%; }
  #tlhint { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
    font-size:12px; color:#3f4757; pointer-events:none; }
  .kv { font:11px/1 ui-monospace, Consolas, monospace; color:#5a6579; }
  #time { font:12px/1 ui-monospace, Consolas, monospace; color:#7fb0ff;
    min-width:66px; text-align:right; }

  /* 预设列表 */
  #presets { max-height:150px; overflow-y:auto; margin-top:6px;
    border:1px solid #22262e; border-radius:6px; }
  #presets .p { padding:5px 9px; font-size:12px; cursor:pointer;
    border-bottom:1px solid #1a1d23; color:#9aa5b8; }
  #presets .p:hover { background:#1e222a; color:#c9d1e0; }
  #presets .p:last-child { border-bottom:none; }
  #presets .p .t { color:#5a6579; font-size:11px; margin-left:6px; }

  input[type=text], input[type=number] { background:#1a1d23; color:#b8c2d4;
    border:1px solid #2b303a; border-radius:5px; padding:4px 7px;
    font:12px/1.2 inherit; outline:none; }
  input[type=text]:focus, input[type=number]:focus { border-color:#3d5478; }
  .row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .row label { font-size:12px; color:#7f8a9d; min-width:52px; }
</style></head>
<body>
<div id="app">
  <div id="stage"><div id="hud">加载中…</div></div>

  <div id="panel">
    <h3>录制</h3>
    <div class="row">
      <label>名称</label>
      <input type="text" id="clipName" value="new-action" style="flex:1">
    </div>
    <div class="row">
      <label>时长</label>
      <input type="number" id="clipDur" value="3" min="0.5" max="60" step="0.5" style="width:70px">
      <span class="kv">秒</span>
    </div>
    <div class="row">
      <button class="primary" id="btnRec">● 开始录制</button>
      <button id="btnStop">■ 停</button>
    </div>
    <div class="row">
      <button id="btnExport">导出 JSON</button>
      <button id="btnSend">送到桌宠</button>
    </div>

    <h3>滑杆 <span style="text-transform:none;letter-spacing:0;color:#4a5262">（拖动即生效）</span></h3>
    <div id="sliders"></div>
    <div class="row" style="margin-top:10px">
      <button id="btnZero">全部归零</button>
      <button id="btnCopy">复制当前值</button>
    </div>

    <h3>预设</h3>
    <div id="presets"></div>
  </div>

  <div id="timeline">
    <div id="tlbar">
      <button class="primary" id="btnPlay">▶ 播放</button>
      <button id="btnPause">❚❚</button>
      <button class="danger" id="btnClear">清空</button>
      <div class="sep"></div>
      <span class="kv" id="framecount">0 帧</span>
      <div class="sep"></div>
      <span class="kv">关键帧间隔</span>
      <input type="number" id="kfStep" value="0.1" min="0.02" max="1" step="0.02" style="width:60px">
      <span class="kv">秒</span>
      <div class="sep"></div>
      <span id="time">0.00s</span>
    </div>
    <div id="tl">
      <canvas id="tlCanvas"></canvas>
      <div id="tlhint">按「开始录制」，拖滑杆，这里会出现曲线</div>
    </div>
  </div>
</div>

<script src="../my-live2d/app/node_modules/pixi.js/dist/browser/pixi.min.js"></script>
<script src="../my-live2d/app/assets/live2dcubismcore.min.js"></script>
<script src="../my-live2d/app/cubism4.patched.js"></script>
<script src="tuner.js"></script>
</body></html>

```

### tuner.js

```js
// 小璃动作调试台 —— 滑杆量化 + 时间轴录制 + 预设播放 + 导出
// 滑杆定义直接沿用旧 panel.html 那套（20 个，参数名和量程都没改）
(function () {
  'use strict';

  const MODEL_URL = 'file:///D:/my-live2d/model/' + encodeURIComponent('大肥鱼') + '.model3.json';

  // ── 滑杆表（旧项目的原样）──────────────────────────────
  const SLIDERS = [
    { g: '头部', p: 'ParamAngleX',    n: '转头',     min: -30, max: 30, step: 1 },
    { g: '头部', p: 'ParamAngleY',    n: '抬头',     min: -30, max: 30, step: 1 },
    { g: '头部', p: 'ParamAngleZ',    n: '歪头',     min: -30, max: 30, step: 1 },
    { g: '眼睛', p: 'ParamEyeBallX',  n: '眼球左右', min: -1,  max: 1,  step: 0.05 },
    { g: '眼睛', p: 'ParamEyeBallY',  n: '眼球上下', min: -1,  max: 1,  step: 0.05 },
    { g: '眼睛', p: 'ParamEyeLOpen',  n: '左眼',     min: 0,   max: 1,  step: 0.05 },
    { g: '眼睛', p: 'ParamEyeROpen',  n: '右眼',     min: 0,   max: 1,  step: 0.05 },
    { g: '表情', p: 'ParamBrowLY',    n: '左眉',     min: -1,  max: 1,  step: 0.05 },
    { g: '表情', p: 'ParamBrowRY',    n: '右眉',     min: -1,  max: 1,  step: 0.05 },
    { g: '表情', p: 'ParamMouthOpenY',n: '张嘴',     min: 0,   max: 1,  step: 0.05 },
    { g: '表情', p: 'ParamMouthForm', n: '嘴角',     min: -1,  max: 1,  step: 0.05 },
    { g: '身体', p: 'ParamBodyAngleZ',n: '身体',     min: -10, max: 10, step: 1 },
    { g: '身体', p: 'ParamBreath',    n: '呼吸',     min: 0,   max: 1,  step: 0.05 },
    { g: '左臂', p: 'Param62',        n: '左大臂',   min: -1,  max: 1,  step: 0.02 },
    { g: '左臂', p: 'Param60',        n: '左小臂',   min: -1,  max: 1,  step: 0.02 },
    { g: '左臂', p: 'Param61',        n: '左手腕',   min: -1,  max: 1,  step: 0.02 },
    { g: '左臂', p: 'Param59',        n: '左透视',   min: 0,   max: 1,  step: 0.02 },
    { g: '右臂', p: 'Param36',        n: '右大臂',   min: -1,  max: 1,  step: 0.02 },
    { g: '右臂', p: 'Param41',        n: '右小臂',   min: -1,  max: 1,  step: 0.02 },
    { g: '右臂', p: 'Param42',        n: '右手腕',   min: -1,  max: 1,  step: 0.02 },
    { g: '右臂', p: 'Param39',        n: '右透视',   min: 0,   max: 1,  step: 0.02 },
  ];

  const DEFAULTS = { ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamBreath: 0.42 };

  const state = {
    model: null, core: null, app: null,
    values: {},                 // 当前滑杆值
    held: {},                   // 要每帧写进模型的参数
    recording: false,
    recStart: 0,
    recDur: 3,
    lastKeyAt: -1,
    frames: [],                 // [{t, v:{...}}]
    playing: false,
    playT0: 0,
    raf: 0,
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);

  // ── 滑杆 UI ────────────────────────────────────────────
  function buildSliders() {
    const box = $('sliders');
    const groups = {};
    for (const s of SLIDERS) (groups[s.g] = groups[s.g] || []).push(s);
    for (const g in groups) {
      const h = document.createElement('div');
      h.style.cssText = 'font-size:11px;color:#4f5a6e;margin:10px 0 5px;';
      h.textContent = g;
      box.appendChild(h);
      for (const s of groups[g]) {
        const row = document.createElement('div');
        row.className = 'sl';
        const init = (s.p in DEFAULTS) ? DEFAULTS[s.p] : 0;
        row.innerHTML =
          '<label>' + s.n + '</label>' +
          '<input type="range" min="' + s.min + '" max="' + s.max + '" step="' + s.step +
          '" value="' + init + '" data-p="' + s.p + '">' +
          '<span class="val" id="v-' + s.p + '">' + fmt(init) + '</span>';
        box.appendChild(row);
        state.values[s.p] = init;
        const inp = row.querySelector('input');
        inp.addEventListener('input', () => {
          const v = parseFloat(inp.value);
          state.values[s.p] = v;
          state.held[s.p] = v;
          $('v-' + s.p).textContent = fmt(v);
          row.classList.toggle('on', Math.abs(v - ((s.p in DEFAULTS) ? DEFAULTS[s.p] : 0)) > 1e-6);
          tryRecord();
        });
      }
    }
  }

  function syncSliderUI() {
    document.querySelectorAll('#sliders input[type=range]').forEach((inp) => {
      const p = inp.dataset.p;
      const v = state.values[p] || 0;
      inp.value = v;
      const el = $('v-' + p);
      if (el) el.textContent = fmt(v);
    });
  }

  // ── 模型 ───────────────────────────────────────────────
  async function loadModel() {
    const stage = $('stage');
    // 不用 resizeTo：构造那一刻 #stage 还没布局完，会拿到 0×0，模型缩放到 0 就看不见了。
    // 显式给尺寸，窗口大小变了再手动 resize。
    const app = new PIXI.Application({
      backgroundAlpha: 0, antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 1.5),
      autoDensity: true,
      width: Math.max(320, stage.clientWidth),
      height: Math.max(320, stage.clientHeight),
      powerPreference: 'high-performance',
    });
    stage.appendChild(app.view);
    state.app = app;

    PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);

    const model = await PIXI.live2d.Live2DModel.from(MODEL_URL, { autoInteract: false });
    app.stage.addChild(model);
    state.model = model;

    const imm = model.internalModel;
    const core = imm.coreModel;
    state.core = core;

    // 跟主项目一样的几个修正
    try {
      const r = imm.renderer;
      if (r && typeof r.setClippingMaskBufferSize === 'function') r.setClippingMaskBufferSize(1024);
    } catch (e) {}

    // 居中 + 缩放到刚好装下
    const fit = () => {
      const w = app.renderer.width / app.renderer.resolution;
      const h = app.renderer.height / app.renderer.resolution;
      // pixi DisplayObject 的 width/height 是当前显示尺寸（已含 scale），先用它反推原始尺寸
      const cur = model.scale.x || 1;
      const bw = model.width / cur;
      const bh = model.height / cur;
      if (!(bw > 0 && bh > 0)) return;
      const s = Math.min((w - 60) / bw, (h - 60) / bh);
      model.scale.set(s);
      model.anchor.set(0.5, 0.5);
      model.x = w / 2;
      model.y = h / 2;
      console.log('[tuner] fit', { w, h, bw: bw.toFixed(1), bh: bh.toFixed(1), s: s.toFixed(3) });
    };
    fit();
    // 第一次布局有时是 0，等一帧再补
    requestAnimationFrame(fit);
    setTimeout(fit, 300);
    window.addEventListener('resize', () => {
      const r = stage.getBoundingClientRect();
      app.renderer.resize(Math.max(320, r.width), Math.max(320, r.height));
      fit();
    });

    // 每帧把滑杆值写进去（跟正式项目一样：设完要 saveParameters，否则下一帧被冲掉）
    imm.on('beforeModelUpdate', () => {
      const h = state.held;
      let any = false;
      for (const p in h) {
        try { core.setParameterValueById(p, h[p]); any = true; } catch (e) {}
      }
      if (any) { try { core.saveParameters(); } catch (e) {} }
    });

    $('hud').innerHTML = '模型已加载 · 参数 <b>' + core._model.parameters.count + '</b> 个 · 滑杆 <b>' + SLIDERS.length + '</b> 个';
    return model;
  }

  // ── 录制 ───────────────────────────────────────────────
  function tryRecord() {
    if (!state.recording) return;
    const t = (performance.now() - state.recStart) / 1000;
    if (t > state.recDur) { stopRec(); return; }
    const step = Math.max(0.02, parseFloat($('kfStep').value) || 0.1);
    if (t - state.lastKeyAt < step - 1e-6) return;
    state.lastKeyAt = t;
    pushFrame(t);
  }

  function pushFrame(t) {
    const v = {};
    for (const p in state.values) v[p] = Math.round(state.values[p] * 1000) / 1000;
    state.frames.push({ t: Math.round(t * 1000) / 1000, v });
    state.frames.sort((a, b) => a.t - b.t);
    updateTlInfo();
    drawTimeline();
  }

  function startRec() {
    state.recording = true;
    state.recStart = performance.now();
    state.recDur = Math.max(0.5, parseFloat($('clipDur').value) || 3);
    state.lastKeyAt = -1;
    state.frames = [];
    pushFrame(0);
    $('btnRec').textContent = '● 录制中';
    $('btnRec').classList.add('danger');
    $('tlhint').style.display = 'none';
  }

  function stopRec() {
    if (!state.recording) return;
    // 补一个收尾帧
    const t = Math.min(state.recDur, (performance.now() - state.recStart) / 1000);
    if (!state.frames.length || state.frames[state.frames.length - 1].t < t - 0.05) pushFrame(t);
    state.recording = false;
    $('btnRec').textContent = '● 开始录制';
    $('btnRec').classList.remove('danger');
    updateTlInfo();
    drawTimeline();
  }

  // ── 播放回放 ───────────────────────────────────────────
  function playRecording() {
    if (!state.frames.length) return;
    state.playing = true;
    state.playT0 = performance.now();
    const total = state.frames[state.frames.length - 1].t;
    const loop = () => {
      if (!state.playing) return;
      const t = (performance.now() - state.playT0) / 1000;
      if (t >= total) { state.playing = false; $('time').textContent = total.toFixed(2) + 's'; return; }
      applyAt(t);
      $('time').textContent = t.toFixed(2) + 's';
      drawTimeline(t);
      requestAnimationFrame(loop);
    };
    loop();
  }

  function applyAt(t) {
    const f = state.frames;
    let a = f[0], b = f[0];
    for (let i = 0; i < f.length - 1; i++) {
      if (t >= f[i].t) { a = f[i]; b = f[i + 1] || f[i]; }
    }
    const span = (b.t - a.t) || 1;
    const k = Math.max(0, Math.min(1, (t - a.t) / span));
    for (const p in a.v) {
      const x = a.v[p], y = (p in b.v) ? b.v[p] : x;
      const v = x + (y - x) * k;
      state.values[p] = v;
      state.held[p] = v;
    }
    syncSliderUI();
  }

  // ── 时间轴绘制 ─────────────────────────────────────────
  function drawTimeline(cursorT) {
    const cv = $('tlCanvas');
    const box = $('tl');
    const dpr = window.devicePixelRatio || 1;
    const W = box.clientWidth - 2, H = box.clientHeight - 2;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!state.frames.length) return;

    const total = Math.max(0.5, state.frames[state.frames.length - 1].t);
    const padL = 8, padR = 8, padT = 8, padB = 14;
    const iw = W - padL - padR, ih = H - padT - padB;
    const xOf = (t) => padL + (t / total) * iw;

    // 网格
    g.strokeStyle = '#1a1d24'; g.lineWidth = 1;
    const gridN = 10;
    for (let i = 0; i <= gridN; i++) {
      const x = padL + (i / gridN) * iw;
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + ih); g.stroke();
    }
    g.beginPath(); g.moveTo(padL, padT + ih / 2); g.lineTo(padL + iw, padT + ih / 2); g.stroke();

    // 选几条有代表性的曲线画
    const SHOW = ['Param62', 'Param36', 'ParamAngleZ', 'ParamMouthForm', 'ParamEyeBallX'];
    const COLORS = ['#4a8cff', '#ff9448', '#63d18b', '#d16fb0', '#f0c040'];
    SHOW.forEach((p, i) => {
      const any = state.frames.some((f) => p in f.v);
      if (!any) return;
      g.strokeStyle = COLORS[i % COLORS.length];
      g.lineWidth = 1.4;
      g.globalAlpha = 0.85;
      g.beginPath();
      state.frames.forEach((f, k) => {
        const v = (f.v[p] !== undefined) ? f.v[p] : 0;
        const x = xOf(f.t);
        const y = padT + ih / 2 - v * (ih / 2) * 0.9;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.stroke();
      g.globalAlpha = 1;
    });

    // 关键帧点
    g.fillStyle = '#8ea3c4';
    for (const f of state.frames) {
      g.beginPath(); g.arc(xOf(f.t), padT + ih - 3, 1.6, 0, Math.PI * 2); g.fill();
    }

    // 录制进度 / 播放游标
    if (state.recording) {
      const t = Math.min(total, (performance.now() - state.recStart) / 1000);
      g.strokeStyle = '#e06060'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(xOf(t), padT); g.lineTo(xOf(t), padT + ih); g.stroke();
      requestAnimationFrame(() => drawTimeline());
    } else if (typeof cursorT === 'number') {
      g.strokeStyle = '#7fb0ff'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(xOf(cursorT), padT); g.lineTo(xOf(cursorT), padT + ih); g.stroke();
    }
  }

  function updateTlInfo() {
    $('framecount').textContent = state.frames.length + ' 帧';
    const t = state.frames.length ? state.frames[state.frames.length - 1].t : 0;
    $('time').textContent = t.toFixed(2) + 's';
  }

  // ── 导出 ───────────────────────────────────────────────
  function buildExport() {
    const used = {};
    for (const f of state.frames) for (const p in f.v) {
      if (Math.abs(f.v[p] - ((p in DEFAULTS) ? DEFAULTS[p] : 0)) > 1e-6) used[p] = true;
    }
    const names = {};
    for (const s of SLIDERS) names[s.p] = s.n;
    return {
      format: 'live2d-tuner/timeline-v1',
      name: $('clipName').value || 'new-action',
      duration: state.frames.length ? state.frames[state.frames.length - 1].t : 0,
      frameStep: parseFloat($('kfStep').value) || 0.1,
      parameters: Object.keys(used).map((p) => ({
        id: p, label: names[p] || p,
        range: (() => { const s = SLIDERS.find((x) => x.p === p); return s ? [s.min, s.max] : [-1, 1]; })(),
      })),
      keyframes: state.frames.map((f) => {
        const v = {};
        for (const p in f.v) {
          const base = (p in DEFAULTS) ? DEFAULTS[p] : 0;
          if (Math.abs(f.v[p] - base) > 1e-6) v[p] = f.v[p];
        }
        return { t: f.t, v };
      }),
      generatedAt: new Date().toISOString(),
    };
  }

  async function exportJson() {
    if (!state.frames.length) { alert('还没有录到帧'); return; }
    const data = buildExport();
    const r = await window.tuner.saveJson(data.name, data);
    if (r && r.ok) {
      $('hud').innerHTML = '已导出 <b>' + data.keyframes.length + '</b> 帧 → ' + r.path;
    }
  }

  async function sendToPet() {
    if (!state.frames.length) { alert('还没有录到帧'); return; }
    const data = buildExport();
    try {
      const res = await fetch('http://127.0.0.1:61944/play-timeline', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      const j = await res.json();
      $('hud').innerHTML = j.ok ? '已送到桌宠：<b>' + (j.data && j.data.frames) + '</b> 帧' : '桌宠回了：' + JSON.stringify(j);
    } catch (e) {
      $('hud').innerHTML = '桌宠没开（' + e.message.slice(0, 40) + '）';
    }
  }

  // ── 预设 ───────────────────────────────────────────────
  async function loadPresets() {
    const list = await window.tuner.listPresets();
    const box = $('presets');
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="p">读不到预设目录</div>'; return; }
    for (const p of list) {
      const d = document.createElement('div');
      d.className = 'p';
      d.innerHTML = p.title + '<span class="t">' + p.id + '</span>';
      d.onclick = () => playPreset(p);
      box.appendChild(d);
    }
  }

  // 预设转成滑杆帧：把 actions[] 逐帧采样
  function playPreset(def) {
    const frames = [];
    const DUR = 0.05;
    let total = 0;
    for (const a of def.actions || []) total = Math.max(total, (a.at || 0) + (a.duration || 1));
    const N = Math.ceil(total / DUR);
    for (let i = 0; i <= N; i++) {
      const t = i * DUR;
      const v = {};
      for (const p in state.values) v[p] = (p in DEFAULTS) ? DEFAULTS[p] : 0;
      for (const a of def.actions || []) {
        const local = t - (a.at || 0);
        const dur = a.duration || 1;
        if (local < 0 || local > dur) continue;
        const raw = Math.min(1, local / dur);
        const k = raw < 0.15 ? (raw / 0.15) : raw > 0.85 ? ((1 - raw) / 0.15) : 1;
        const s = a.strength === undefined ? 1 : a.strength;
        if (a.values) for (const p in a.values) {
          if (!(p in v)) continue;
          const cur = v[p];
          v[p] = cur + (a.values[p] - cur) * k;
        }
        if (a.kind === 'look') {
          const dx = a.direction === 'left' ? -1 : a.direction === 'right' ? 1 : 0;
          const dy = a.direction === 'up' ? 1 : a.direction === 'down' ? -1 : 0;
          v['ParamEyeBallX'] = dx * s * k;
          v['ParamEyeBallY'] = dy * s * k;
          v['ParamAngleX'] = dx * 18 * s * k;
          v['ParamAngleY'] = dy * 12 * s * k;
        }
        if (a.kind === 'tilt') v['ParamAngleZ'] = (a.direction === 'left' ? -1 : 1) * 14 * s * k;
        if (a.kind === 'smile') v['ParamMouthForm'] = 0.6 * s * k;
        if (a.kind === 'nod') {
          const n = a.count || 1;
          v['ParamAngleY'] = Math.sin((local / dur) * Math.PI * 2 * n) * 10 * s * k;
        }
        if (a.kind === 'shake_head') {
          const n = a.count || 1;
          v['ParamAngleX'] = Math.sin((local / dur) * Math.PI * 2 * n) * 12 * s * k;
        }
      }
      frames.push({ t: Math.round(t * 100) / 100, v });
    }
    state.frames = frames;
    $('clipName').value = def.id || def.title || 'preset';
    $('clipDur').value = total.toFixed(1);
    $('tlhint').style.display = 'none';
    updateTlInfo();
    drawTimeline();
    playRecording();
    $('hud').innerHTML = '正在回放预设 <b>' + (def.title || '') + '</b>（' + frames.length + ' 帧，' + total.toFixed(1) + 's）';
  }

  // ── 绑定 ───────────────────────────────────────────────
  function bind() {
    $('btnRec').onclick = () => state.recording ? stopRec() : startRec();
    $('btnStop').onclick = () => { stopRec(); state.playing = false; };
    $('btnPlay').onclick = () => playRecording();
    $('btnPause').onclick = () => { state.playing = false; };
    $('btnClear').onclick = () => {
      state.frames = []; state.playing = false; state.recording = false;
      $('btnRec').textContent = '● 开始录制';
      $('btnRec').classList.remove('danger');
      $('tlhint').style.display = 'block';
      updateTlInfo(); drawTimeline();
    };
    $('btnExport').onclick = exportJson;
    $('btnSend').onclick = sendToPet;
    $('btnZero').onclick = () => {
      for (const s of SLIDERS) {
        const d = (s.p in DEFAULTS) ? DEFAULTS[s.p] : 0;
        state.values[s.p] = d; state.held[s.p] = d;
      }
      syncSliderUI();
    };
    $('btnCopy').onclick = async () => {
      const txt = JSON.stringify(buildExport(), null, 2);
      try { await navigator.clipboard.writeText(txt); $('hud').innerHTML = '当前数据已复制到剪贴板'; }
      catch (e) { $('hud').innerHTML = '复制失败：' + e.message; }
    };
    window.addEventListener('resize', () => drawTimeline());
  }

  // ── 启动 ───────────────────────────────────────────────
  (async function boot() {
    buildSliders();
    bind();
    try {
      await loadModel();
    } catch (e) {
      $('hud').innerHTML = '模型加载失败：<b>' + e.message + '</b>';
      console.error(e);
      return;
    }
    loadPresets();
    // 打开就把待机呼吸架上，不然是个僵的
    state.held['ParamBreath'] = state.values['ParamBreath'];
  })();
})();

```

### launch.ps1（给桌面快捷方式用的启动器）

```powershell
# Jingyu Tuner launcher -- pure ASCII on purpose.
# PS 5.1 reads a BOM-less .ps1 as ANSI(GBK); Chinese path literals in the script
# turn into mojibake like "D:\deepseek?..??" and Test-Path fails.
# So every path lives in launcher-paths.json (written by Node, always UTF-8)
# and this script never contains a non-ASCII byte.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $here 'launcher-paths.json'
if (-not (Test-Path -LiteralPath $cfgPath)) { Write-Host "missing launcher-paths.json"; exit 2 }

$cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$exe  = $cfg.electronExe
$main = $cfg.mainJs
$cwd  = $cfg.cwd

if (-not (Test-Path -LiteralPath $exe))  { Write-Host "electron not found"; exit 3 }
if (-not (Test-Path -LiteralPath $main)) { Write-Host "main.js not found"; exit 4 }

Start-Process -FilePath $exe -ArgumentList $main -WorkingDirectory $cwd
exit 0

```

### launcher-paths.json

```json
{
  "electronExe": "D:\\electron\\electron.exe",
  "mainJs": "D:\\my-tuner\\main.js",
  "cwd": "D:\\my-tuner"
}
```

---

## 跑起来

```powershell
# 必须有 electron。用你自己项目里那份就行
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath 'path\to\electron.exe' `
  -ArgumentList 'D:\your\tuner\main.js' -WorkingDirectory 'D:\your\tuner'
```

**必须删 `ELECTRON_RUN_AS_NODE`**。这个变量存在时 Electron 会被当 Node 跑，秒退无窗口。
如果你从 DSH 之类的 Electron 宿主里启动，它的 shell 环境带着这个变量，一定会踩到。

---

## 接进你自己的项目要改什么

1. **`tuner.js` 里的 `MODEL_URL`**

   ```js
   const MODEL_URL = 'file:///D:/my-live2d/model/大肥鱼.model3.json';
   ```
   改成你的 `.model3.json` 绝对路径。用 `file:///` 前缀，路径里的中文要 `encodeURIComponent`。

2. **`SLIDERS` 表** —— 换成你模型的参数（见上面的「滑杆表」一节）。

3. **`DEFAULTS`** —— 你模型的默认值。左右眼一般是 1，呼吸 0.42 是这台机器的默认，按你的改。

4. **`main.js` 里的 `webSecurity: false`** —— 跨目录读模型文件需要关掉。如果你的模型在同一个目录，可以开回来。

5. **依赖的 pixi 和 cubism** —— `tuner.html` 最后三个 `<script>` 指向的是一个现成项目的 `skin/` 目录：

   ```html
   <script src="../my-live2d/app/node_modules/pixi.js/dist/browser/pixi.min.js"></script>
   <script src="../my-live2d/app/assets/live2dcubismcore.min.js"></script>
   <script src="../my-live2d/app/cubism4.patched.js"></script>
   ```
   改成你自己的路径。三个文件分别是：pixi.js、Live2D 官方 Cubism Core、pixi-live2d-display 的 Cubism4 适配层。

---

## 坑清单

| 现象 | 原因 | 解法 |
|---|---|---|
| 窗口开了，模型区全黑 | `PIXI.Application` 传了 `resizeTo: stage`，构造那一刻容器还没布局，拿到 0×0 | 显式给 `width/height`，加 `requestAnimationFrame` 补一次 fit |
| 缩放算不出来 | 用了 `internalModel.originalWidth`，这版没有这个属性 | 用 `model.width / model.scale.x` 反推 |
| 滑杆拖了模型不动 | 参数被每帧 `loadParameters()` 冲掉 | `beforeModelUpdate` 里写，写完 `saveParameters()` |
| `motionManager.playing` 永远是 true | 待机 IDLE 也算在内 | 别拿它判断；要测手势就 hook `model.motion` 数调用次数 |
| 导出文件巨大 | 每帧把所有参数都写进去 | 只写跟默认值不同的 |
| 启动脚本报 `electron not found` 但路径看着对 | `.ps1` 是 UTF-8 无 BOM，PS 5.1 按 GBK 读，中文路径变乱码 | 路径放 JSON（UTF-8 写入），脚本一个字的中文都不出现 |
| `Start-Process` 静默失败 exit=1 | 用了 `-LiteralPath`，它只有 `-FilePath` | 改 `-FilePath` |

### 那条中文路径的坑值得单独说

第一版启动脚本长这样：

```powershell
$exe = 'D:\我的插件\my-pet\node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { Write-Host "electron not found: $exe"; exit 2 }
```

输出：

```
electron not found: D:\鎴戠殑鎻掍欢\my-pet\node_modules\electron\dist\electron.exe
```

`.ps1` 存成 UTF-8 无 BOM 时，PowerShell 5.1 按系统 ANSI（中文机器是 GBK）解码，
「插件」两个字的 UTF-8 字节被当成 GBK 读，就成了「鎻掍欢」。

**解法**：路径全部挪进一个 JSON 文件（Node / 编辑器写，永远是 UTF-8），
脚本里只 `ConvertFrom-Json`，不含任何非 ASCII 字节。可以自己数一下：

```js
Buffer.from(fs.readFileSync('launch.ps1', 'utf8'), 'utf8').filter(b => b > 127).length   // 应该是 0
```

这个方法对 `.cmd`、`.vbs` 启动器同样适用。

---

## 还没做的（欢迎接）

- **曲线编辑器**：现在只能录，不能直接拖关键帧。录完想微调只能重录。
- **骨骼视图**：点某个参数，模型上高亮对应部位。需要读 cdi3 的 Parts 分组。
- **送到桌宠**：`tuner.js` 里有个 `sendToPet()` 会 POST 到 `127.0.0.1:61944/play-timeline`，
  桌宠端没写这个接口的话会 404。想让录好的动作在桌宠上直接预览，得在桌宠那边补一段。
- **多轨**：现在所有参数挤在一条时间轴上，动作多了会乱。

---

## 顺手写的一句

这套东西的价值不在界面好看，在于**把「动作」从手艺变成了数据**。

数据能传、能改、能喂给 AI、能 diff。手艺只能一个人练。

写完跑通了，用着挺顺。有更好的做法欢迎改。
