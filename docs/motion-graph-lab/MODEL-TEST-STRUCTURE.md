# MODEL-TEST-STRUCTURE · 三模型结构层核查报告

> 代理：impl-modelscan · 日期：2026-11-10 · 契约版本 v4（scan.mjs 实测）
> 输入目录（均为干净解压，未改动）：
> - miku：`C:/Users/User/AppData/Local/Temp/ngt/miku/`
> - 小祥：`C:/Users/User/AppData/Local/Temp/ngt/xiao/小祥/`（中文目录名完好）
> - DeepSeek：`C:/Users/User/AppData/Local/Temp/ngt/deepseek/DeepSeek/`（与仓库在用「大肥鱼」`D:/Desktop/DSH-L2D/DeepSeek免费公皮/DeepSeek/` 同源）

---

## 1. 三模型结构对比表

| 维度 | miku（VTS 导出） | 小祥 / 丰川祥子（VTS 导出） | DeepSeek 大肥鱼（DSH 自有） |
|---|---|---|---|
| model3.json 数量 | 1（miku.model3.json） | 1（丰川祥子.model3.json） | 3（大肥鱼.dsl2d.2048 / 大肥鱼.dsl2d / 大肥鱼.model3.json；运行时选 dsl2d.2048） |
| model3 Version 字段 | 3 | 3 | 3 |
| moc3 实际版本（文件头） | `MOC3` + 版本字节 **5**（Cubism 5.0 编辑器导出） | 同左 **5** | 同左 **5** |
| 纹理组 | miku.4096/ 共 **6** 张 | 丰川祥子.4096/ 共 **1** 张 | dsl2d-2048/ 共 **5** 张（另有原始 4096 5 张） |
| Physics 登记 | miku.physics3.json ✓ | 丰川祥子.physics3.json ✓ | 大肥鱼.physics3.json ✓ |
| Poses 字段 | **无** | **无** | **无** |
| DisplayInfo (cdi3) | ✓ | ✓ | ✓ |
| **Expressions 登记** | **[] 空数组** | **字段缺失** | **21 个**（dsl2d.2048 版） |
| 实际 exp3 文件 | **8 个**：QQ人/前倾/唱歌/圈圈/比心/水印/脸红/葱 | **1 个**：客服小祥 | **23 个**（21 已登记；竖食指开/关未登记） |
| **Motions 登记** | **{} 空对象** | **字段缺失** | **7 组**：抚胸手打开/抚胸手关闭/竖手指打开/竖手指关闭/狗尾巴草打开/狗尾巴草关闭/Idle |
| 实际 motion3 文件 | **1 个**：Scene1.motion3.json（另有 Untitled Animation.can3 源文件，非运行时格式） | **0 个** | **8 个**（7 已登记；脱捕.motion3.json 未登记） |
| EyeBlink 组 | ParamEyeROpen, ParamEyeLOpen | **[] 空** | ParamEyeROpen, ParamEyeLOpen |
| LipSync 组 | **[] 空** | 无此组 | ParamMouthOpenY |
| cdi3 参数数 | **141** | **30** | **509** |
| 物理输出参数 | **83** | **4** | **292** |
| 命名风格 | 混合：有 ParamAngleX/Y/Z，也有 Param36/39-43/59-62（与大肥鱼同款参数命名） | 纯标准 Cubism 命名（ParamAngleX…），**无 Param36 系列** | W3 风格（AngleX/HipAngleX/LArm/Param36…） |
| 附带 | miku.vtube.json、items_pinned_to_model.json、模型使用说明.txt | icon.jpg、丰川祥子.vtube.json | vbridger、psd（大肥鱼.png）、physics bak-pre-limb-* |

**关键结论**
- 三模型 moc3 头部版本字节均为 5（Cubism 5.0 导出）。**需实测确认 DSH renderer 内置 live2dcubismcore 支持 moc3 v5**，否则三个模型在加载阶段直接失败（静态无法验证，属运行时项）。
- 「VTS 导出不登记资源」确认为**通病**：miku 与小祥的 model3.json 均未登记 exp3/motion3；只有 DSH 自有的大肥鱼登记齐全。
- miku 实际有 8 个表情 + 1 个动作（比任务书口头转述的 6 exp + 1 motion 略多，以目录实查为准）。

## 2. capability-scan 真实输出

工具支持 `--model-dir <dir> --out-dir <dir>`（scan.mjs:17-18），无需改工具即可指定任意模型目录。三模型均跑通：

```
[scan] model=miku 参数=141 物理输出=83
[scan] 通道 59（标准 23 + W3 36）：unsupported=49 supported=9 approximate=1
[scan] W3 排除 4 条：gesture.wave, gesture.hand_to_chin, gesture.arms_crossed, gesture.open_hands
[scan] 写出 …/profile.miku.json

[scan] model=丰川祥子 参数=30 物理输出=4
[scan] 通道 59（标准 23 + W3 36）：unsupported=54 supported=4 approximate=1

[scan] model=大肥鱼.dsl2d.2048 参数=509 物理输出=292
[scan] 通道 59（标准 23 + W3 36）：supported=51 approximate=4 unsupported=4
```

汇总：

| 模型 | 参数 | 物理输出 | supported | approximate | unsupported | 表情资产 | 动作资产 |
|---|---|---|---|---|---|---|---|
| miku | 141 | 83 | 9 | 1 | 49 | **0**（8 个文件未登记） | **0**（1 个文件未登记） |
| 丰川祥子 | 30 | 4 | 4 | 1 | 54 | **0**（1 个文件未登记） | 0 |
| 大肥鱼.dsl2d.2048 | 509 | 292 | 51 | 4 | 4 | 21 | 7 |

- miku 仅剩 supported：torso.sway / gaze.x / gaze.y / body.breathing / face.blink(approximate) / ext.pose.rest·finger·grass·chest·body.relax（后者命中 Param36 系列，但**全部标记含物理输出需 own**）。
- 小祥仅剩 supported：torso.sway / gaze.x / gaze.y / body.breathing。
- scan 副作用：固定向仓库 `docs/` 写 `Capability-Profile-<modelId>.md`。本次为 miku/丰川祥子 生成的两份 md 已移至 `C:/Users/User/AppData/Local/Temp/ngt/scanout/{miku,xiao}/` 存档，仓库恢复干净；大肥鱼那份与既有内容一致（git 无 diff）。

**扫描器自身缺口（记录，不改动）**
1. **W3 registry 是大肥鱼口径**：`tools/w3-registry/registry.json` 的 ext.expression.* 条目（兔牙/加载/…）与「未引用资产」（model/Animation/脱捕…）都指向大肥鱼。对 miku 跑出的 49 个 unsupported 里有一大半是「W3 登记的参数在模型里不存在：key1…key13」——这不是 miku 缺能力，是 registry 没有按模型参数化。
2. **bindings 正则口径缺口**：`tools/capability-scan/bindings.mjs:27` `head.yaw: DIRECT([/^AngleX$/])` 匹配不到标准命名 `ParamAngleX`（miku/小祥都有此参数）。同理 head.pitch/roll。扩为 `/^(Param)?AngleX$/` 即可救回 6 个通道（两模型 × 三轴）。这是本次发现的最划算的工具修复点。

## 3. FileReferences 空登记问题 · 修复评估（只评估，未实现）

### 3.1 现状证据链

- **renderer 只认 model3.json，无目录扫描回退**：
  - 表情加载：`packages/renderer/src/app/lappmodel.ts:210-236`，只走 `this._modelSetting.getExpressionCount()/getExpressionName(i)/getExpressionFileName(i)`（即 model3.json FileReferences.Expressions），载入 `this._expressions` map。
  - 动作加载：`lappmodel.ts:708` `getMotionFileName(group, no)`（FileReferences.Motions）。
  - `packages/renderer/src` 全目录 grep `readdir|scandir|readdirSync` = **0 处命中**。
- **宿主白名单是「动态 index ∪ 静态大肥鱼名单」**：
  - `packages/dsh-l2d-plugin/lib/host-guard.mjs:188-239` `loadModelIndex`：运行时读模型目录全部 model3.json（discoverModelFiles），从 FileReferences 抽 expressions/motionGroups，TTL 10s 缓存（#28 改造）。
  - `host-guard.mjs:356-365`：index 为空 → 回退 `STATIC_EXPRESSIONS/STATIC_MOTION_GROUPS`（即 choreography.mjs 硬编码大肥鱼 21 表情 + 6 动作组）；非空则并集。
  - `choreography.mjs:49-84` `MODEL_EXPRESSIONS/MODEL_MOTION_GROUPS` **硬编码大肥鱼**；`validateStep`（L490/496）静态校验只用这份，无 profile 注入（`validateChoreography` 的 options.expressions 覆盖口在 l2d_act 链路未见使用）。

### 3.2 空登记的实际后果（miku / 小祥）

1. 渲染端 `_expressions`/`_motions` 为空 → 任何 l2d_set_expression / l2d_play_motion 都拿不到资源，必然失败。
2. 宿主 index 为空 → 白名单只剩大肥鱼静态名单。**miku 真实表情名（QQ人/唱歌/葱…）会被 l2d_act 校验直接拒绝**（"表情名不存在"），即使修好了渲染端也过不了宿主；而大肥鱼表情名（兔牙…）能过校验却在渲染端失败——两头拧。

### 3.3 方案对比

**方案 A：登记补丁工具（推荐）**
- 写一个 `tools/` 脚本（如 `tools/capability-scan/register-assets.mjs`）：扫描模型目录全部 `*.exp3.json` / `*.motion3.json`，对照 model3.json FileReferences，把缺失条目补登记（Expressions 补 `{Name, File}`，Motions 补组名 → `{File, FadeIn/Out}`；组名可用文件名或统一组），另存 `*.model3.patch.json` 或就地备份改写。
- 改动面：**1 个新工具脚本 + 生成文件**，零源码改动；与 host-guard loadModelIndex（读 FileReferences）、capability-scan（读 FileReferences）、index.js capability.json 路由全链路天然兼容——所有消费方都以 model3.json 为唯一事实源。
- 风险：低。注意点：动作组名需要选择语义（Idle 组会被 lappmodel 自动循环重启，非 Idle 组进 MODEL_MOTION_GROUPS 手播面）；miku 的 Scene1.motion3.json 是否适合作 Idle 待实测。

**方案 B：renderer 目录扫描回退**
- 需改 lappmodel.ts 加载流程（model3.json 之外追加目录枚举）、host-guard 白名单联动、以及 web 端资源发现——`fetchOptionalAsset` 走 HTTP，浏览器侧没有 readdir，还得给 `index.js` 的 /dsh-l2d/model 静态路由加目录列表 API。
- 改动面：renderer + plugin host + web 路由三层；破坏「model3.json 是唯一资源清单」的架构约定（capability-scan 与 guard 都按此约定 fail-closed）。
- 风险：中高，收益仅覆盖「模型作者不登记」这一种脏数据，且方案 A 以数据修复方式即可根治。

**结论：推荐方案 A**（登记补丁工具），保持单一事实源；方案 B 记录为不推荐。

## 4. 体态（pose）结构核查与新模型接入 profile 步骤

### 4.1 pose 资源现状

- 三模型 model3.json **均无 Poses 字段**；体态能力完全依赖 capability profile 的 `ext.pose.*` 语义通道（scan.mjs 从 exp3/motion3 引用参数 + 物理输出表推导）。
- `l2d_set_pose`：`packages/renderer/src/app/pose-controller.ts:12-23` **POSE_IDS 硬编码** Param36/39/40/41/42/43/59/60/61/62（大肥鱼终态实测值）。对三模型的影响：
  - 大肥鱼：正常。
  - miku：参数恰好存在（命名与大肥鱼同款），但 scan 证实**这批参数全是物理输出**——写前必须 own，否则被 physics 覆盖；且 preset 数值（如 Param39: 0.322）是按大肥鱼调的，对 miku 语义不一定成立。
  - 小祥：**这批参数不存在**（30 个参数全是标准命名）→ setPose 写无效参数。
- `l2d_posture`：`overlay.js:5570-5618`，必须先有 `window.__L2D_PROFILE__`（来自 `/dsh-l2d/capability.json`），`planPostureExecution(pProfile, …)` 全部参数 id 取自画像；无 profile → `reason:'profile-loading'`；画像里无匹配通道 → skipped/degraded（fail-closed，不硬凑）。**此路径是 profile 驱动的，接入新模型只要画像到位即可用**。
- 白名单来源回答（任务书问题）：`choreography.mjs` 的 MODEL_EXPRESSIONS/MODEL_MOTION_GROUPS 是**硬编码**（非 profile 驱动）；host-guard 在其上做动态并集兜底。新模型无 profile 时：l2d_posture 拒绝执行（fail-closed）、l2d_set_pose 写死参数（危险）、表情/动作白名单为大肥鱼静态名单（错位）。

### 4.2 新模型接入 profile 完整步骤清单

1. **（若 FileReferences 空登记）先跑登记补丁**（§3.3 方案 A 工具产出），否则 scan 与运行时都看不到表情/动作。
2. **跑扫描**：`node tools/capability-scan/scan.mjs --model-dir <模型目录> --out-dir tools/capability-scan`
   - 产出 `tools/capability-scan/profile.<modelId>.json`（modelId = model3.json 文件名去后缀，与 index.js 路由匹配规则一致）。
   - 副作用：同时写 `docs/Capability-Profile-<modelId>.md`，需决定去留（本次已移出仓库）。
3. **画像路由匹配**：`packages/dsh-l2d-plugin/lib/index.js:1592-1624` 按「`discoverModelFiles(MODEL_DIR)[0]` 推导的 modelId」精确匹配 `profile.<modelId>.json`，匹配不到**回退字母序第一份**——多模型混部时可能拿错画像，接入新模型务必确认当前 MODEL_DIR 的第一个 model3.json 与 profile 文件名对齐。
4. **W3 registry 参数化**（现状缺口）：`tools/w3-registry/registry.json` 为大肥鱼口径；新模型要么为其生成专属 registry，要么让 w3-controls 对陌生模型跳过 ext.expression.* 判定，否则 unsupported 数虚高、真实能力被埋没。
5. **bindings 正则修复**（工具缺口）：`bindings.mjs:27-29` head.* 正则扩为 `/^(Param)?AngleX$/`（miku/小祥即可获得 head.yaw/pitch/roll 六通道）。
6. **setPose profile 化**（现状缺口）：`pose-controller.ts` POSE_IDS/PRESETS 硬编码大肥鱼；新模型接入需把 pose 参数表与 preset 值搬到 profile（或至少按 profile.ext.pose.* 的 sourceId 动态取）。
7. **运行时验证**：POST `/dsh-l2d/capability/rescan`（仅本地回环）→ 重载页面让 overlay 预取 capability.json → 逐通道实测（moc3 v5 是否能加载是第一道门槛）。

## 5. 产出与存档

- 本报告：`docs/motion-graph-lab/MODEL-TEST-STRUCTURE.md`
- 三模型 profile JSON + 画像 md 存档：`C:/Users/User/AppData/Local/Temp/ngt/scanout/{miku,xiao,deepseek}/`
- 未改动任何源码；仓库 `docs/` 恢复原状（git status 仅剩他人未跟踪文件）。
