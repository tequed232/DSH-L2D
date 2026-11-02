# 看了你那两份文档，补一些我们踩到的（Live2D + Electron 桌宠）

先说明：我们是同一只模型的另一个用法——**把这只 Live2D 做成桌面宠物**（整屏透明浮层、能拖能摸）。
你们的《配饰面板》和《动作调试台》我们对着试过，结构很清楚，坑清单也准。
下面只列**你们没写、或者结论跟我们不一样**的部分，都能直接用。

---

## ① 穿透 + 可交互，其实做得到

你们文档里的结论是：

> `setIgnoreMouseEvents(true, {forward:true})` 在 33 版实测完全转发不了任何事件……所以「穿透状态 + 还能点模型」这件事做不到。

`forward:true` 不转发这件事我们确认了，**但换一条路就做得到**：别让页面接管鼠标，让主进程接管。

```
主进程  setInterval(16ms) 读 screen.getCursorScreenPoint()
   → IPC 送到页面（鼠标在窗口里的坐标）
页面    逐像素 alpha 命中（WebGL readPixels）
   → IPC 告诉主进程"现在在不在她身上"
主进程  setIgnoreMouseEvents(false) / (true) 实时切换
```

关键三点：

1. **`readPixels` 必须紧跟一次渲染**。我们挂在 `renderer.on('postrender')` 里读，
   在别的地方读 alpha 恒为 0（我们一开始就是被这个坑了两轮）。
2. **不要用鼠标事件做触发**，用主进程的坐标轮询——窗口处在"穿透"状态时页面收不到任何 mousemove。
3. 命中判定就是 `alpha > 阈值`（我们用的 22/255），再叠加"面板矩形"这类 DOM 区域。

效果：桌面照常可用、窗口一直穿透，同时能点她、拖她、按部位区分触摸（头/胸/腰/裙/手臂/腿/脚/尾巴）。

> 附一条：整屏透明置顶窗在 Windows 上偶发「Win32 里可见、屏幕就是不画」。
> 救法是 `win.hide()` → `showInactive()` → `setAlwaysOnTop(true, 'screen-saver')`，
> 再挂个 2.5 秒的保活做同样的事。你们的「隐藏人物」按钮如果遇到"点了没反应"，多半是这个。

---

## ② 「脱掉」不能写 0，要写模型自己的默认值

你们的 `DEFAULT_PARTS` 里 `Clothes1: 1`、`Clothes5: 1` 是对的。
但通用逻辑里如果一律「关 = 写 0」就会出错：**这两个参数默认值本来就是 1，写 0 反而等于穿上。**

我们之前踩的正是这个：换裙子回不去、尾巴点掉回不来。

```js
// 读模型真正的默认值，别假设是 0
const p = core._model?.parameters;
const ids = p?.ids ?? core._model?.parameterIds;
const idx = Array.from(ids).indexOf(id);
const fallback = Number.isFinite(p?.defaultValues?.[idx]) ? p.defaultValues[idx] : 0;
```

「全关」按钮更稳的写法是：**回到"默认状态"而不是"全 0"**，语义就是"卸掉所有配饰"。

---

## ③ 换眼表情会叠成两层眼

你们面板里列了 `key3 圈圈眼 / key4 爱心眼 / key5 ＞＜ / key6 屑屑眼`。
这四个表情**只画新眼，不会藏掉原来的眼眶/眼球/眼白**，勾上就是两层。

我们的修法：

```js
// 底眼那几个 part（这只模型上是这几组）
const EYE_BASE_PARTS = ['Part48','Part43','Part49','Part37','Part35','Part36',
                        'Part139','Part140','Part141','Part144','Part145','Part146'];

// 在 beforeModelUpdate（或高优先级 ticker）里，跟参数一起写
core.setPartOpacityById(id, hide ? 0 : 1);
core.saveParameters();   // 跟参数一样，写完要存回去
```

**还有一个时机的坑**：不要"表情一开就藏、一关就放"。
表情本身有 ~0.4 秒淡入淡出，藏早了/放晚了都会出现「脸上没有眼睛」的一帧。
我们的做法是拿表情的**淡入淡出区间**算：`[start+fade*0.9, start+duration-fade*0.9]` 才藏。

另外：`key4 爱心眼` 是换虹膜，不需要藏底眼（它本来就干净）；
`key3 圈圈眼` 藏了底眼只剩两个白圈（这个表情作者没画螺旋），自己看着办。

---

## ④ 有些参数是"假"的

我们在同一只模型上逐个验过（写进去、截图对比）：

| 参数 | 结论 |
|---|---|
| `key1` 黑脸 | 写了没变化（Exp3 里确实写了 key1=1，但模型没用） |
| `JawOpen` | 没变化。**张嘴要用 `ParamMouthOpenY`** |
| `NoseNeer` / `MouthRollUpper` / `MouthRollLower` | 作者配置里有，几何探测看不到变化 |
| `key9` 大牙 | 有效（就是兔牙），可留 |

所以你们面板里「黑脸」那个勾选框，勾了不会有任何事发生——不是代码问题。

（同理，如果你们后面加"眉毛"滑块：`ParamBrowLY/RY`、`BrowInnerUp` 是有效的，
但这只模型的眉毛被刘海挡得很死，±1 拉满也几乎看不出，我们最后是配着头部动作才勉强读出来。）

---

## ⑤ 时间轴格式：建议给 `parameters[]` 加 `default`

你们现在的导出：

```json
{
  "format": "live2d-tuner/timeline-v1",
  "duration": 3.0,
  "frameStep": 0.1,
  "parameters": [{ "id": "ParamAngleY", "label": "抬头", "range": [-30, 30] }],
  "keyframes": [{ "t": 0.3, "v": { "ParamAngleY": -6 } }]
}
```

只写「跟默认值不同」的参数这个设计很好。**建议每条 parameter 再加一个 `default`**：

```json
{ "id": "ParamAngleY", "label": "抬头", "range": [-30,30], "default": 0 }
```

理由是回放端就不用维护 `DEFAULTS` 表了——你们现在的

```js
const DEFAULTS = { ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamBreath: 0.42 };
```

是硬编码的，换模型就得改。默认值写进文件以后，任何播放器都能直接：
**没提到的参数 = 文件给的默认值**，跨模型可播。

这条对「让 AI 生成动作」也关键：AI 拿到默认值才知道"没提到 = 保持原样"，不然它会乱猜。

---

## ⑥ 你们的「送桌宠」按钮，我们这边已经实现了

你们文档里写：

```js
fetch('http://127.0.0.1:61944/play-timeline', { method: 'POST', body: JSON.stringify(data) })
// 桌宠端没写这个接口的话会 404
```

现在通了。返回形状就是你们代码里期待的：

```json
{ "ok": true, "data": { "frames": 3, "result": "playing 3 params / 3 frames" } }
```

我们实现时踩到两条，你们如果要在别处也做播放器，注意：

1. **每帧写完参数必须 `saveParameters()`**——Cubism 每帧末尾 `loadParameters()` 会把值盖回去。
   你们文档里写了这条，我们验证确实如此。
2. **参数名要做前缀别名**：你们导出的是 `ParamAngleY`、`ParamEyeBallY`，
   而有些引擎/中间层内部叫 `AngleY`、`EyeBallX`。回放端建议：
   `先按原名找，找不到就去掉/补上 "Param" 前缀再找`。
3. 播完记得把用到的参数**写回默认值**再收手，否则 baseline 停在最后一帧、人会僵住。

---

## ⑦ 我们采纳了你们一条

`ELECTRON_RUN_AS_NODE` 必须删这条，是真经验：
从 Electron 宿主里 spawn 子 Electron 时会继承这个变量，子进程被当成 node 跑、秒退无窗口。

我们已经在自己的启动路径里补了：

```js
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electronExe, args, { env, detached: true, stdio: 'ignore' });
```

谢谢，这条帮我们排掉一个隐患。

---

## ⑧ 另外一个可能对你们有用的分法

做「AI 生成动作」的时候，我们把参数分成两层：

- **语义层**（AI 只说这些）：`AngleX/Y/Z`、`PositionX/Y/Z`、`EyeBallX/Y`、`MouthOpenY/Form`、
  加上语义动作 `look / nod / shake_head / tilt / smile / blink`；
- **原始层**（引擎负责）：`Param62` 这种手部关节、`ParamBreath` 这种物理输入。

AI 只写语义层，中间层编译成参数曲线（缓动、范围裁剪、冲突检测都在中间层做）。
否则让 AI 直接写 500 个参数，它写出来的动作会互相打架——比如头和身体同向转、
眨眼和眯眼叠加、物理输入被硬拽导致抽搐。

---

## 最后

上面每一条都是我们在这只模型（大肥鱼 / DeepSeek 公皮）上实测过的，不是推测。
有两条我标了"我们也没完全搞清楚"的（圈圈眼只剩白圈、眉毛被刘海挡），那种就别当结论。

如果你们要验，最快的办法是：把参数写进去 → 截一张图 → 跟基准图逐像素比。
纯靠肉眼很容易漏掉那种"变了 3%"的效果。

有问题随时问，我们也在同一只模型上折腾。
