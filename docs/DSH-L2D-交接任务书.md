# DSH-L2D 交接任务书

> 交接范围：把「静态立绘预览」推进到「真实 Live2D 模型在 DSH 界面内的透明叠加层中完整显示并可驱动」。
> 编写时间：2026-11-01。上一手已完成约 70%，卡在渲染上。

---

## 0. 一句话现状

DSH 插件的**全部外围能力（注入、路由、设置、音效、余额、纹理降档、模型格式适配）已跑通并用 curl 验证**；
**唯独真实 Live2D 的绘制没有确认成功**——用户反馈「只显示上半身」，我在外部浏览器里只看到空白。
渲染实现当日已从第三方 pixi 封装切换到**官方 Cubism SDK Framework**，但新的实现尚未做视觉验证。

---

## 1. 目标（按优先级）

| # | 目标 | 验收标准 |
|---|---|---|
| P0 | 模型在 DSH 右下角叠加层里**完整显示**（全身，不裁切、不变形） | 肉眼可见完整角色，含头发/裙摆摆动 |
| P1 | 透明背景 | 角色背后能看到 DSH 界面，不是黑底/白底 |
| P2 | 缩放/拖动可用且不变形 | 拖动位置记忆；改缩放后仍完整显示 |
| P3 | 表情与动作可触发 | 21 个表情、7 个动作组均可点选生效，成对动作能复位 |
| P4 | 参数驱动（呼吸/眨眼/视线/口型） | 静止时有自然微动；后续接 ParamMixer |

P0 没做出来之前，P3/P4 不用动。

---

## 2. 环境（都在本机，路径照抄）

| 项 | 路径 / 值 |
|---|---|
| DSH 安装目录 | `D:\DeepSeek Harness Desktop`（Electron，版本 0.2.1-rc.5，app.asar 182MB） |
| DSH profile | `C:\Users\User\.dsh\profiles\desktop` |
| 插件源码 | `D:\Desktop\DSH-L2D\packages\dsh-l2d-plugin`（已以 junction 链入 profile 的 node_modules） |
| 项目根 | `D:\Desktop\DSH-L2D` |
| 模型目录 | `D:\Desktop\DSH-L2D\DeepSeek免费公皮\DeepSeek` |
| Cubism SDK | `D:\Desktop\DSH-L2D\vendor\cubism\CubismSdkForWeb-5-r.5`（含 Core、Framework、Samples） |
| Node / pnpm | Node 22+，pnpm 12.5.1 |
| 共享依赖 | `C:\Users\User\.dsh\profiles\node_modules`（`@deepseek-ai/schemastery` 等在此） |

**运行/调试要点**

- DSH 启动时会打印一行 `dsh web: http://127.0.0.1:<随机端口>/?token=...`，端口每次不同。
- 找端口：扫 `netstat` 的 127.0.0.1 监听端口，逐个 `curl /dsh-l2d/settings.json`，**返回内容包含 `soundVolume` 的才是 DSH**（有些端口会返回 200 + 二进制，是误判）。
- 改 `lib/index.js`（宿主侧）→ **必须重启 DSH**；只改 `lib/overlay.js`（浏览器侧）→ **F5 即可**。
- 重启命令（注意：用 explorer 启动才不会被父进程带走）：
  ```powershell
  taskkill /F /IM "DeepSeek Harness.exe" /T
  Start-Process -FilePath explorer.exe -ArgumentList '"D:\DeepSeek Harness Desktop\DeepSeek Harness.exe"'
  ```

---

## 3. 已完成、无需重做的部分

### 3.1 插件宿主 `packages/dsh-l2d-plugin/lib/index.js`

DSH 的插件系统是 **Cordis**（Koishi 同作者框架）。安装三要素已就位：
`profile/package.json` 加 `link:` 依赖 + `dsh.profile.bundles`；`cordis.patch.yml` 加 `- insert: [{id: dsh-l2d, name: dsh-l2d}]`；目录链接进 `node_modules`。

**关键机制（务必不要改坏）**

- 前端注入只走 `root.on('webserver/index-inject', table => table.push({kind:'script', placement:'body', text}))`，且必须是**内联 script 行**：由自己 `createElement('script')` 加载并吞掉 `onerror`。
  用 `kind:'script-src'` 一旦 404 会 reject `__DSH_BOOT_READY__`，**整个 DSH 起不来**。
- 注入表在宿主启动时**只收集一次**，所以 `apply()` 里第一件事就是注册注入行；**不能**把 `apply` 挂在对象级 `inject` 上等 `webServer`。服务依赖用 `root.inject(['webServer','credentials'], cb)` 局部等。
- 路由注册：`ctx.webServer.register({ kind:'exact'|'prefix', path, handler })`。

**已注册路由**（全部用 curl 验证过 200）

| 路由 | 说明 |
|---|---|
| `/dsh-l2d/overlay.js` | 叠加层脚本 |
| `/dsh-l2d/core.js` | Cubism Core（228KB，从 vendor 直读） |
| `/dsh-l2d/renderer.js` | 渲染包（构建产物） |
| `/dsh-l2d/model/*` | 模型资源（prefix 路由，扩展名白名单 + `..` 过滤 + 根目录校验） |
| `/dsh-l2d/test.html` | 独立自检页（排查用） |
| `/dsh-l2d/settings.json` | 设置读写（GET/PUT，PUT 仅回环） |
| `/dsh-l2d/config.json` | 非敏感设置下发 |
| `/dsh-l2d/balance.json` | 余额（60s 缓存，失败沿用上次） |
| `/dsh-l2d/audio/index.json`、`/dsh-l2d/audio/file?name=` | 自定义音效 |
| `/dsh-l2d/status.json` | 自检 |

设置落盘在 `C:\Users\User\.dsh\l2d-settings.json`。

### 3.2 叠加层 `lib/overlay.js`（约 640 行，纯 JS）

- 透明叠加容器，`pointer-events:none`，只有角色与控件可点；拖拽移动并把位置存 localStorage
- 四态演示（待机/问答/操作/离席），状态胶囊点击切换
- 按下/松开音效：优先取 `~\.dsh\l2d-audio\` 下的自定义音频，没有则用 WebAudio 合成「鸭子叫」
- 单击或悬停 350ms → 弹气泡显示 API 余额（用户自己填 Key）
- 齿轮 → 设置面板（Key / 音效 / 缩放 / 刷新间隔），PUT 到宿主
- **已含渲染接入代码**：创建 `<canvas>`，`initRenderer()` 依次加载 `/dsh-l2d/core.js`、`/dsh-l2d/renderer.js`，调用 `window.DSH_L2D.mount(canvas, {modelUrl,width,height,zoom})`；失败则回退静态图并提示
- `canvasBox()` 已防御性处理「容器尺寸为 0」；有 `ResizeObserver` 在尺寸变化时调 `layout()`

### 3.3 渲染包 `packages/renderer`

**当日已从 pixi 版重做为官方 SDK 版**（详见 §5）。

```bash
pnpm -F @dsh/renderer build   # 产物 → ../dsh-l2d-plugin/assets/renderer.js（约 260KB）
```

`src/fw/` 是 SDK 的 `Framework/src`（59 个 ts），`src/app/` 是 SDK 样例的 `Samples/TypeScript/Demo/src`（13 个 ts）。Vite alias `@framework → src/fw`。

对外 API（挂 `window.DSH_L2D`）：
`loadCore(url)` / `mount(canvas,{modelUrl,width,height,zoom})` / `layout(w,h,zoom)` / `setParameter(id,v,w)` / `playMotion(group,index)` / `setExpression(name)` / `destroy()` / `isReady()` / `getInfo()`

### 3.4 模型格式适配 `tools/vts-adapter`

这个包是 **VTube Studio 包**，不是标准 Cubism 包：`model3.json` 仅 550 字节，`Motions`/`Expressions` 全空，引用关系都在 `.vtube.json` 的 28 条热键里。
该工具已重建出带 21 表情 + 7 动作组的 `大肥鱼.dsl2d.model3.json`，并补 `HitAreas: []`、注入 `ParamMouthOpenY` 到 LipSync 组。**40 条参数映射 0 条无效。**

### 3.5 纹理降档 `tools/texture-opt`

原包 5 张图集合计 **592MB 显存**（含 8192×8192 = 256MB），浏览器直接崩。
已生成 2048 档：`dsl2d-2048/` + `大肥鱼.dsl2d.2048.model3.json`，**592MB → 64MB（-89%）**。
叠加层当前指向 `大肥鱼.dsl2d.2048.model3.json`。

---

## 4. 模型事实清单（务必遵守）

| 项 | 值 |
|---|---|
| moc3 | Cubism 5（header=5） |
| 画布（Cubism 单位） | 1.0 × 2.05（图集/PSD 为 3749×7697 像素级） |
| 参数 | 509 个，**大量自定义命名**：`AngleX` 而非 `ParamAngleX`，还有 `CheeckPuff`、`Mouthpucker` |
| Drawable | 715 个 |
| 表情 | 21 个（exp3） |
| 动作组 | 7 个：**6 个是成对的状态切换**（举手开/关、竖手指开/关、狗尾草开/关，且 `Loop:true`）+ `Idle` |
| 纹理 | 5 张 |

**坑处**

1. **参数语义以模型自带 `.vtube.json` 的 40 条绑定表为权威**，禁止按标准参数名硬编码，否则头不会转。
2. 成对动作必须用**状态机**记录开/关，随机播会卡在半截姿势。
3. `model3.json` 必须有 `HitAreas` 数组（部分渲染器直接 `.map` 会崩），适配器已补。
4. 模型文件**不入库、不拷贝**（授权禁止重新分发），一律从模型目录直读。

---

## 5. 当前卡点：真实渲染没确认成功

### 5.1 用户看到的现象

> 「我要求模型能够完整显示，不要只显示上半身」

**这句话很重要**：说明在 DSH 里模型**确实被画出来了**，只是被裁切/缩放不对。请以 DSH 内的实际观感为准。

### 5.2 我在外部浏览器里的观测（可能是误导）

用 `http://127.0.0.1:<port>/dsh-l2d/test.html` 自检页测 pixi 版时：模型解析成功（715 drawables、bounds 273×560、位置 x=74/y=0），但画布上只有一个白点；同时用一个红色 `Graphics` 方块验证，方块**能正常绘制**。
→ 结论被推断为「模型没被绘制」。

**这条推断很可能是错的**：那个浏览器标签页可能被遮挡，`requestAnimationFrame` 被节流到 0，任何依赖 rAF 的渲染都不会出画面（pixi 的 ticker 正是 rAF 驱动）。
**教训：不要用被遮挡的浏览器窗口验证 rAF 驱动的渲染；以 DSH 内实际显示或可见窗口为准。**

### 5.3 「只显示上半身」的最可能原因

pixi 版里用的是 `scale = min(w/box.w, h/box.h)` 且模型按**宽度**对齐；该模型画布宽高比 0.49（很瘦很高），按宽适配时高度会超出画布 → 只看到上半身。
官方版已改为按「更受限的一边」适配：

```ts
if (modelAspect >= canvasAspect) matrix.setWidth(2.0 * zoom);
else matrix.setHeight(2.0 * zoom);
```

**这就是当前最需要被验证的一处改动。**

### 5.4 已完成的官方 SDK 改造（尚未视觉验证）

- `src/index.ts` 重写：`CubismFramework.startUp/initialize` → `new LAppSubdelegate().initialize(canvas)` → `mgr.loadModelUrl(dir, file)` → 等 `model.getModel()` 就绪 → `fitModel()` → rAF 循环调 `sub.update()`
- 对 vendored 样例打了三处补丁（**都在 `src/app/` 里，注意不要被覆盖**）：
  1. `lappsubdelegate.ts`：`gl.clearColor(0,0,0,1)` → `(0,0,0,0)`（透明背景，叠加层必需）
  2. `lappsubdelegate.ts`：初始化与 `onResize()` 里跳过 `_view.initializeSprite()`（demo 的背景图/齿轮无资源会报错）
  3. `lapplive2dmanager.ts`：`initialize()` 不再自动 `changeScene()`；新增 `loadModelUrl(dir, fileName)` 按 URL 加载
- 构建通过：74 modules → 260KB（对比 pixi 版 768KB）

---

## 6. 接手后的建议顺序

1. **先把自检页跑通**（不要直接在 DSH 里猜）：
   `http://127.0.0.1:<port>/dsh-l2d/test.html`
   自检页 HUD 会实时显示 `frames / lastError / canvasW / canvasH / drawables / params / zoom`。
   - `frames` 必须持续增长 → 说明 rAF 在跑（若为 0，先解决窗口可见性，不要怀疑渲染）
   - `drawables: 715`、`params: 509` → 模型解析正常
2. **确认是否完整显示**：画布 420×560 里应看到完整角色；不满意就调 `fitModel()`（可先用 `?zoom=0.8` 试）。
3. 接通到 DSH：F5 DSH 页面，看右下角。**注意叠加层画布只有 240×300（乘缩放）**，模型细节会更小；如需要可在设置里调 scale。
4. P3 表情/动作：用 `tools/vts-adapter` 产出的 `dist/capabilities.json` 生成按钮，调 `setExpression(name)` / `playMotion(group)`。
5. P4 参数驱动：把 `packages/core` 的 `ParamMixer` 每帧结果写进 `coreModel.setParameterValueById()`（`packages/core` 已有 7 项测试，仲裁规则现成）。
   注意：**口型参数只能由 lipSync 通道写**，行为层不得直接写 `ParamMouthOpenY`。

---

## 7. 现成命令

```bash
# 依赖
pnpm install

# 构建渲染包（改完 src 必跑）
pnpm -F @dsh/renderer build

# 核心参数仲裁器测试（7 项）
pnpm test:core

# 重新解析模型（改了模型目录结构时）
node tools/vts-adapter/index.mjs "D:\Desktop\DSH-L2D\DeepSeek免费公皮\DeepSeek"

# 重新生成低显存图集
node tools/texture-opt/index.mjs "D:\Desktop\DSH-L2D\DeepSeek免费公皮\DeepSeek" \
  --model3 "大肥鱼.dsl2d.model3.json" --max 2048
```

---

## 8. 硬约束（违反会出事故）

1. **注入行只能用内联 `script`**，且 `apply()` 第一件事就注册。
2. **模型文件、Cubism SDK 的 Core 都不入库**：授权禁止重新分发模型；Core 受 Live2D 许可约束。`.gitignore` 已排除 `models/`、`vendor/`、`**/live2dcubismcore.min.js`。
3. **写操作只允许回环地址**；模型路由保留扩展名白名单与 `..` 过滤。
4. 改 `lib/index.js` 需重启 DSH；只改 `lib/overlay.js` 只需 F5。
5. 不要覆盖 `src/app/` 里那三处补丁（透明清屏、跳过精灵、loadModelUrl）。

---

## 9. 仓库状态

- `git init -b main` 已完成，**尚无任何提交**（本机 `user.name`/`user.email` 未配置）。
- profile 配置改动前已备份：`package.json.bak-l2d-20261101-210008`、`cordis.patch.yml.bak-l2d-20261101-210008`（同目录）。
- 目录结构：

```
apps/stage-web/          M3 Expressive 设置界面（独立预览用，非必需）
packages/core/           ParamMixer 参数仲裁器 + 7 项测试
packages/renderer/       ★ 渲染包（官方 SDK 版）：src/index.ts、src/fw/、src/app/
packages/dsh-l2d-plugin/ ★ DSH 插件：lib/index.js、lib/overlay.js、assets/
tools/vts-adapter/       VTS 包 → 标准 Cubism 包（已跑通）
tools/texture-opt/       纹理降档（已跑通）
vendor/cubism/           SDK 5-r.5（不入库）
docs/                    设计文档与本文
```

---

## 10. 交接者可优先确认的三件事

1. 自检页里 `frames` 是否增长 —— 决定「渲染没跑」还是「绘制有问题」。
2. 画布中角色是否完整 —— 决定 `fitModel()` 的对齐策略是否正确。
3. DSH 叠加层里是否透明 —— 决定清屏 alpha 补丁是否生效。

这三条一旦确认，剩下的都是接线工作。
