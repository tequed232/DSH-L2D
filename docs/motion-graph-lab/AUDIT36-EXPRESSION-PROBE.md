# #36 表情通道视觉归因补证报告：smile_open_mouth ×2 + blush ×4（2026-11-10）

> 目的：为 issue #36 六条待复核标签（#11/#26 smile_open_mouth、#27/#33/#44/#49 blush）补齐
> §9.2 所缺的**表情通道视觉归因**证据（AUDIT36-VISUAL-ATTRIBUTION.md §二/§三指出的补证路径）。
> 方法：走渲染端既有唯一表情通道 `window.DSH_L2D.setExpression`（与 `l2d_set_expression` 工具同一入口），
> **不做参数注入**（口型保护/无参数管控红线不触碰），probe 自带 dev-server(5321) + 独立 Edge 实例，宿主 3080 未动。

## 一、执行产物

- 探针脚本：`tools/runtime-probe/expression-probe.mjs`（新增，独立 CLI，复用 `lib/host.mjs` 渲染环境）；
  `lib/host.mjs` 仅新增可选参数 `deviceScaleFactor`（默认 1，向后兼容）。
- 数值留档：`data/runtime-probe/expression-probe-1794308346450.json`（最终轮，三表情全 PASS）。
- 截图（每表情 4 张：中性全身 / 中性面部 / 注入全身 / 注入面部，面部窗两两完全对齐）：

| 表情 | 中性基准（面部） | 注入后（面部） | 全身对照 |
|---|---|---|---|
| 兔牙 | expr-neutral-face-兔牙.png | expr-face-兔牙.png | expr-neutral-兔牙.png / expr-injected-兔牙.png |
| ＞＜ | expr-neutral-face-＞＜.png | expr-face-＞＜.png | expr-neutral-＞＜.png / expr-injected-＞＜.png |
| 脸红 | expr-neutral-face-脸红.png | expr-face-脸红.png | expr-neutral-脸红.png / expr-injected-脸红.png |

截图规格：画布放大至 720×540，deviceScaleFactor=2 → 面部窗约 1036×648 px（2 倍超采样）。

## 二、表情映射依据（标签 → 表情名）

模型表情清单（`大肥鱼.dsl2d.2048.model3.json` FileReferences.Expressions，21 个）中**无** `smile_open_mouth`/`blush` 直译名，
按语义 + 渲染端既有用法定位（代码出处：`packages/dsh-l2d-plugin/lib/overlay.js`）：

| 标签语义 | 映射表情 | 依据 |
|---|---|---|
| smile_open_mouth 张口笑 | **兔牙**（主）/ ＞＜（辅） | ① 语义：「兔牙」exp=key9=1，视觉为张口露牙的笑（见 §三）；② 渲染端把「兔牙」用作开心/开心反馈表情（overlay.js `friendlyHead`/聊天回应均 setExpression('兔牙')）；③ ＞＜ exp=key5=1 为闭眼张口笑，作旁证 |
| blush 脸红 | **脸红** | 同名同义直配；exp 文件 `Exp3/脸红.exp3.json`（key7=1）；渲染端害羞场景 `shyChest` 亦用「脸红」（overlay.js:1098） |

表情文件（静态证据）：
- `Exp3/兔牙.exp3.json` → key9 Add 1
- `Exp3/＞＜.exp3.json` → key5 Add 1（key3/4/6 Add 0）
- `Exp3/脸红.exp3.json` → key7 Add 1

## 三、逐条视觉归因结论（GLM 多模态实查截图对）

数值层：三表情 setExpression 全部返回 true，key 参数 0→1 确认生效，中性复位复核正常（JSON 留档）。

### 1. 「兔牙」→ smile_open_mouth（#11/#26）

- **中性**：嘴闭合（小抿笑），眼睁开，无露牙。
- **注入后**：嘴**张开**（微张幅度），嘴角上扬呈笑意，上唇一侧**露出白色兔牙（虎牙）**；眼睛仍睁开。
- **结论**：视觉 =「张着嘴的笑（露兔牙）」，与标签语义 smile_open_mouth（张口笑）**吻合**。
  张口幅度属微张~半张，非夸张大笑——若素材图张口幅度更大，＞＜（闭眼张口笑）可作补充桥接候选。
- **建议**：#11/#26 可 approved（表情通道视觉直证 + 数值 probe PASS）。#26 为 inferred 级，同判即可（同一语义同判）。

### 2. 「＞＜」→ smile_open_mouth 旁证（不单独落判）

- **注入后**：双眼闭合成 ＞＜ 弧线，嘴微张带笑，双颊泛浅红。
- **结论**：是「闭眼大笑」变体，与张口笑部分重合（张口+笑），但主特征是闭眼——作为 #11/#26 的辅助证据，不单独作为主归因表情。

### 3. 「脸红」→ blush（#27/#33/#44/#49）

- **中性**：双颊肤色正常，无红晕。
- **注入后**：**双颊出现明显粉红色红晕**（对称分布于颧骨区），嘴保持闭合微笑，眼睁开——害羞神态。
- **结论**：视觉 =「脸颊红晕」，与标签语义 blush **直接吻合**，红晕清晰可辨、非歧义。
- **建议**：#27/#33/#44/#49 四条可 approved（4 条同名同值同语义，统一裁决）。

## 四、裁决建议汇总

| 标签 | 表情通道证据 | 数值证据 | 视觉一致性 | 建议 |
|---|---|---|---|---|
| #11 smile_open_mouth | 兔牙 截图对 | key9 0→1, PASS | 吻合（张口露牙笑） | **approved** |
| #26 smile_open_mouth | 同上（同族同判） | 同上 | 吻合 | **approved** |
| #27/#33/#44/#49 blush | 脸红 截图对 | key7 0→1, PASS | 直接吻合（双颊红晕） | **approved** ×4 |

纪律说明：本报告仍为**建议层**，落库须由用户/主理人逐条 `review.mjs decide`（状态不可覆写守卫）。
标签对象是素材插画；本次补证证明「渲染端存在与标签语义一致的真实表情效果」，为桥接可行性提供视觉归因；
素材画面本身是否画了张口笑/脸红，属素材复核范畴（classified 文档已确认语义）。

## 五、复跑方式

```bash
node tools/runtime-probe/expression-probe.mjs --expression 兔牙,＞＜,脸红
```
