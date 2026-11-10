# #36 §9.2 门禁视觉归因调查报告（2026-11-10 18:40）

> 目的：对 §9.2 视觉归因门禁 9 条（耳族 3 / smile_open_mouth 2 / blush 4）做 GLM 多模态归因前置调查——确认每条到底「能不能归因、缺什么证据」。

## 一、耳族 3 条（#2 whale_fin_ears / #16 / #30）——架构性不可达，历史证据充分

**调查结论：§9.2 视觉归因对耳族参数当前无法执行——不是缺截图，而是 Node Ownership 白名单排除。**

| 证据 | 内容 |
|------|------|
| 现场 probe（今日重跑） | `--mode baseline --param LEar1 --value -1` → verdict FAIL：`LEar1:not_hostable`——耳/发/配饰参数被 Node Ownership 白名单排除（防误删边界，不为审计破例） |
| 历史 probe（白名单收紧前） | baseline-LEar1/2/3、REar1/2/3 六参数 **全部注入成功**：requested=1 → observed median=1，movedBeyondNoise:true，guard OK（hard [-1,1]），baseline median≈0（自然静止）——data/runtime-probe/*.json 留档 |
| 视觉确认（GLM 多模态今日实查） | head-neutral.png：耳鳍状深色翼状结构在头发两侧清晰存在，形态与标签 whale_fin_ears「鲸鳍状耳发翼」一致；注入后截图（渲染调试台全页）可见模型完整形态 |
| 截图裁剪 | 无裁剪产物；全页截图耳部区域过小，但耳鳍结构本身可辨识 |

**裁决建议**：3 条可 approved——标签语义（部件存在）有中性帧视觉直证；参数控制有历史数值 probe 6/6 注入成功硬证；「当前不可注入」是架构边界（白名单设计使然，物理摆动归模型自驱），note 注明以上三点。是否采信历史 probe 由用户裁定（保守选项：维持 needs_review 至物理通道视觉验证）。

## 二、smile_open_mouth 2 条（#11/#26）——缺 probe 截图，无注入记录

data/runtime-probe/ 无 smile/口形相关截图与数值 JSON；口形参数（ParamMouthOpenY 类）受口型保护红线管控（写路径禁用）——**视觉归因需先定位「哪个参数控制 smile_open_mouth 表情」再走表情通道（expression3 而非参数注入）**。维持 needs_review，补证路径：表情通道 probe（l2d_set_expression 后截图）。

## 三、blush 4 条（#27/#33/#44/#49）——无直接参数，同上

无 blush 相关截图/JSON。脸红在表情清单里（「脸红」expression）——补证路径同上：表情通道 probe 截图比对。

## 四、AngryMove1-8（参数族，非 61 条标签）

head 窗 9 张全齐（head-neutral + head-AngryMove~8）+ 数值 8/8 PASS，但初筛裁剪窗只覆盖头部与上胸——AngryMove2/3/4/6/7/8「无可见差异」≠「无效果」；需全身窗对照补证。宿主 3080 在线后可跑全身窗 probe 补证。

## 五、建议下一步

1. 耳族 3 条：用户裁定是否采信历史 probe（建议 approved + 架构边界 note）；
2. smile/blush 6 条：走表情通道 probe（宿主在线，一轮即可补齐 6 条截图）——可立即执行；
3. AngryMove 全身窗补证：宿主在线后跑一轮；
4. 全部补齐后 #36 剩余条目（含 N1/N2 命名待用户确认的 4 条）一次闭环。
