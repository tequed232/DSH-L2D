# MODEL-TEST-RENDER：三模型浏览器真渲染加载测试报告

- 日期：2026-11-10
- 执行：impl-render-e2e（真渲染层）
- 通道：dev-server（tools/dev-server/index.mjs）+ WorkBuddy Browser MCP（真浏览器加载 / 与 /dsh-l2d/pet.html）
- 模型来源（拷贝，未移动）：`C:/Users/User/AppData/Local/Temp/ngt/{miku, xiao/小祥, deepseek/DeepSeek}` → `D:/Desktop/DSH-L2D/_test-models/{miku, xiao, deepseek}`

## 一、结论速览

| 模型 | moc3 解析 | 纹理加载 | 模型渲染显示 | 表情可用 | 动作可用 | moc3 版本兼容 |
|---|---|---|---|---|---|---|
| miku（miku.model3.json） | ✓ | ✓（6/6 张） | ✓（渲染循环持续） | ✗ 未登记（预期内） | ✗ 未登记（预期内） | ✓ 无问题 |
| 小祥（丰川祥子.model3.json，中文文件名） | ✓ | ✓（1/1 张） | ✓（渲染循环持续） | ✗ 未登记（预期内） | ✗ 未登记（预期内） | ✓ 无问题 |
| DeepSeek 皮（大肥鱼.dsl2d.2048.model3.json，对照基线） | ✓ | ✓（5/5 张） | ✓（渲染循环+Idle 动作播放中） | ✓（兔牙 ok:true） | ✓（Idle ok:true） | ✓ 无问题 |

**总体结论：三模型均能在浏览器真渲染链路（Cubism Core 5-r.5 + renderer.js）完整加载并渲染，无一失败。**
miku/小祥 的 `FileReferences.Expressions=[] / Motions={}`（VTS 导出不登记）不影响模型本体渲染：Moc/Textures/Physics 已登记的部分全部正常，仅表情/动作通道不可用——与预判一致。

## 二、测试环境与取证手段

### 取证通道说明（重要）
本次会话中 WorkBuddy Browser 的**截图通道全程不可用**（`Browser screenshot exceeds the 10 MiB image limit`，对任意 clip/质量/任意页面——包括纯 JSON 文本页——均复现，属环境级问题非页面问题）；`dom_cua_get_visible_dom` 亦持续返回空快照。因此视觉取证受限，改用以下两条**等效且更精确**的证据链：

1. **渲染器内部状态取证（HTTP 探针）**：调试页 `tools/dev-server/public/index.html` 每 400ms 轮询 `/ai/poll`，且**仅当 `DSH_L2D.isReady()` 为真（即 renderer mount 成功、Cubism model 实例非空）才轮询**（index.html:609-610）。通过 `POST /ai/call(l2d_get_state)` → 页面执行 `L.getInfo()` → `POST /ai/result` → `GET /ai/result?id=` 读回，拿到渲染器内部状态（frames/drawables/params/glErr/shader/lastError/实时参数值）。
2. **服务端读盘取证（fslog 外挂）**：`_test-models/_fslog.cjs` 经 `NODE_OPTIONS="--require …"` 注入（未改任何源码），记录 dev-server 对模型目录的每次 `readFileSync`。渲染器按 model3.json 逐项拉取 moc3/纹理/physics/表情/动作，读盘记录即「渲染器实际请求了什么资源」的直接证据。

> 控制台错误取证局限：调试页内建 console 捕获（#log），但 DOM 通道失效无法读取；以 `getInfo().lastError`（值恒为 `none`）+ `glErr`（值恒为 `0`）作为渲染错误判据替代，覆盖 Cubism/WebGL 错误面。

### 模型文件要点（测试前静态核对）
- 三份 moc3 头部均为 `MOC3 05`（xxd -l 8 实测）= **Cubism 5.0 导出**，与 CubismSdkForWeb-5-r.5 Core 同代，**不存在旧 moc3 兼容性问题**。
- miku.model3.json：Moc + 6 纹理（miku.4096/）+ Physics + DisplayInfo；**无 Expressions/Motions 字段**（磁盘上存在 QQ人.exp3.json 等 8 个 exp3 与 Scene1.motion3.json，但未登记）。
- 丰川祥子.model3.json：Moc + 1 纹理 + Physics + DisplayInfo；**无 Expressions/Motions 字段**（磁盘上存在 客服小祥.exp3.json，未登记）。
- 大肥鱼.dsl2d.2048.model3.json：Moc + 5 纹理（dsl2d-2048/）+ Physics + **21 表情 + 7 动作组**全部登记（对照组）。

## 三、逐模型实测记录

### 1. miku（dev-server :5341，DSH_L2D_MODEL_DIR=_test-models/miku）

**静态路由**：/api/models → `["miku.model3.json"]`；model3.json/moc3/texture_00 均 HTTP 200。

**fslog 读盘记录**（浏览器页面加载触发，证明渲染器按 model3.json 拉取全链）：
```
miku.model3.json ×2 → miku.moc3 → miku.physics3.json
→ miku.4096/texture_00.png … texture_05.png（6/6 全部）
→ miku.physics3.json
```

**渲染器状态探针**（l2d_get_state 两次）：
- 第一次：`frames=7, drawables=440, params=141, glErr="0", shader="vs-ok len=484", lastError="none", pxW=396, pxH=616, maxTex=16384, motion: group=none idle=0`
- 第二次：`frames=8, utime 0.11→0.13, ParamBreath 0.608→0.623, ParamAngleX 0.215→0.246` —— **帧循环持续推进，呼吸/身体参数实时变化**

**功能探针**：
- `l2d_set_expression("QQ人")` → `{ok:false}`（exp3 文件在磁盘但未登记，符合预期）
- `l2d_play_motion("Idle")` → `{ok:false}`（无动作组，符合预期）

**判定**：moc3 ✓ / 纹理 ✓（6 张全拉取 + glErr=0 + shader ok）/ 渲染显示 ✓ / 表情✗动作✗（未登记，预期内）/ 版本 ✓。

### 2. 小祥 / 丰川祥子（dev-server :5342，DSH_L2D_MODEL_DIR=_test-models/xiao）

**中文文件名编码专项**：`/api/models` 返回 `["丰川祥子.model3.json"]`；URL 编码（%E4%B8%B0%E5%B7%9D%E7%A5%A5%E5%AD%90…）访问 model3.json / moc3 / `丰川祥子.4096/texture_00.png` / physics 全部 HTTP 200。**编码链路（encodeURIComponent → resolveInside 内 decodeURIComponent）工作正常，中文文件名不是失败因素。**

**fslog 读盘记录**（两次 boot）：
```
丰川祥子.model3.json ×2 → 丰川祥子.moc3 → 丰川祥子.4096/texture_00.png → 丰川祥子.physics3.json（×2 轮）
```

**渲染器状态探针**：
- 第一次：`frames=6, drawables=32, params=30, glErr="0", shader="vs-ok", lastError="none", motion: group=none idle=0`
- 第二次：`frames=7, utime 0.10→0.11, ParamBreath 0.593→0.608` —— **帧循环持续推进**

**功能探针**：
- `l2d_set_expression("客服小祥")` → `{ok:false}`（未登记，预期内）
- `l2d_play_motion("Idle")` → `{ok:false}`（无动作组，预期内）

**判定**：moc3 ✓ / 纹理 ✓ / 渲染显示 ✓ / 表情✗动作✗（未登记，预期内）/ 版本 ✓。drawables=32（模型比 miku 简单）符合该模型体量。

### 3. DeepSeek 皮 / 大肥鱼（dev-server :5343，对照基线）

**静态路由**：/api/models → 3 个 model3.json 变体；2048 档 model3.json/moc3/texture/Exp3/兔牙/Animation/IDLE 均 200。

**pet.html 真渲染**（dev-server 上 pet.html 的模型 URL 来自 status.json.model；dev-server status.json **不含 model 字段**（index.mjs:463-466），故走 pet.html:29 的写死 fallback `大肥鱼.dsl2d.2048.model3.json`——本目录该文件真实存在，fallback 命中）：
```
fslog：大肥鱼.dsl2d.2048.model3.json → 大肥鱼.moc3 → dsl2d-2048/texture_00.png → Exp3/兔牙 → Animation/IDLE
（第二次完整加载：21 个 exp3 全部 + 7 个 motion3 全部 + 5 张纹理 + physics）
```
**pet.html 渲染成立**（fallback 命中 + 全资源拉取；pet 页不轮询 /ai/poll，无 getInfo 通道，视觉通道失效无法截图，判定依据为资源全链拉取）。

**调试页状态探针**：
- 第一次：`frames=15, drawables=715, params=509, glErr="0", shader="vs-ok", lastError="none", motion: idle=1`
- 功能探针：`l2d_set_expression("兔牙")` → `{ok:true}`；`l2d_play_motion("Idle",0)` → `{ok:true}`
- 第二次：`frames=24, motion: group=Idle_0 playing=1 t=57.00` —— **Idle 动作真实播放中，帧循环持续推进**

**判定**：基线全绿。三模型在同一 dev-server/渲染链路上的差异仅在于 model3.json 登记内容，与静态核对完全吻合，交叉验证了 miku/小祥 的 ✗ 是「未登记」而非「加载失败」。

## 四、已知问题 / 局限记录

1. **dev-server pet.html 模型解析限制（非模型问题）**：dev-server 的 `/dsh-l2d/status.json` 返回 `{ok,version,mode}` 无 `model` 字段，pet.html 恒走写死 fallback `大肥鱼.dsl2d.2048.model3.json`（pet.html:29）。miku/小祥 目录下该 fallback 404（fslog 各留证 2 次读盘尝试）→ 页面 `fallbackToImage` 回退静态立绘（且 `/dsh-l2d/avatar.png` 路由在 dev-server 不存在，回退图亦 404）。**模型本体没问题**——同模型在调试页 `/` 渲染全绿。真机宿主 status.json 带 model 字段则无此问题。
2. **浏览器视觉取证失效（环境级）**：本会话截图通道对任意页面均报 `screenshot exceeds 10 MiB`（含 800×600 clip、quality 30、纯 JSON 页）；`dom_cua_get_visible_dom` 恒空快照。已用 HTTP 探针 + fslog 双证据链替代，并如实标注取证局限。
3. **AI 探针消费节奏**：浏览器标签页失焦时 setInterval 被节流，探针回执延迟 8~15s 属正常，非渲染卡顿（frames/utime 证明帧循环正常）。

## 五、测试现场清理

- dev-server 进程：5341（pid 13240→22384→25488）、5342、5343 均已杀。
- `netstat -ano | grep -E ":(5341|5342|5343|5300).*LISTENING"` → **无监听，端口全部释放**（残留 TIME_WAIT/CLOSE_WAIT 为 TCP 挥手残态，自动老化）。
- 写入物：`_test-models/{miku,xiao,deepseek}/`（拷贝目录）、`_test-models/_fslog.cjs`（取证外挂）、本报告。**未改任何源码，无 commit/push。**
