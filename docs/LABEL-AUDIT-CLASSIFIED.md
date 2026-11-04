# DSH-L2D 标签分类审计视图（61 条待复核 · P0 标签复核）

- 生成：2026-11-05 00:31（audit 导出，只读，未修改任何标签状态）
- 来源：`node tools/gallery-schema/review.mjs list --limit 100` 全量 61 条
- 用途：人工逐条裁决的辅助视图。**本报告不做任何 approve/reject 决策。**
- 前置警示（用户裁决）：**不能仅凭参数名称推断其实际动作语义**——下表"候选参数"仅为语义线索，须经渲染探针确认后才可作为桥接依据。

---

## 一、耳朵族（whale_fin_ears 系）

**标签**：#2、#16、#30（`part=whale_fin_ears`，鲸鳍状耳发翼）
**同族一致性**：3 条同名同值，证据等级 source_exact(#2) vs inferred(#16/#30)——**跨素材证据不一致，属 8 组争议项之一**。

| 标签 | 中文语义 | CDI3 候选参数 | 对应性评估 |
| --- | --- | --- | --- |
| whale_fin_ears | 鲸鳍状耳发翼（外观部件） | `LEar/REar1-3`（<兽耳PHA/B/C） | ⚠️ **部分对应**：参数控制兽耳形变相位；但"鲸鳍耳发翼"是外观描述，该部件是否由 Ear 族驱动、还是纯静态 ArtMesh，**须渲染探针确认**（改动 LEar/REar 观察耳发翼是否动） |

**人工决策点**：确认耳发翼可动性 → 可动则该标签可桥接 `ear_move` 语义通道；不可动则标签降级为纯外观描述（不影响动作库）。

## 二、尾巴族（whale_tail / 狗尾草系）

**标签**：#1、#15、#24、#35（`part=whale_tail`，蓝色鲸尾鳍）+ #53/#54（狗尾草挥动/道具）

| 标签 | 中文语义 | CDI3 候选参数 | 对应性评估 |
| --- | --- | --- | --- |
| whale_tail | 蓝色鲸尾鳍 | `Clothes5`（5. 尾巴）、`Param52`（尾巴翻面）、`Param_Angle_Rotation84-87`（[0]~[3]尾巴） | ✅ **强对应**：Phase 2 桥接已建立（tail_sway → Rotation84~87 四段级联，cdi3 名逐段吻合） |
| chibi_dog_tail_grass_wave (#53) | Q版持狗尾草挥动 | `Movement1`（1. 狗尾草） | ✅ 已建立桥接（E2E 验证） |
| chibi_dog_tail_grass_prop (#54) | 手持道具狗尾草 | 同上（道具存在性） | ✅ 一致 |

**同族一致性**：whale_tail 4 条跨素材全部同名；置信度 0.80–0.95 极差 0.15（争议组 1）；证据等级 mixed（source_exact/inferred）。
**人工决策点**：whale_tail 4 条统一裁决即可（同一语义，建议同判）。

## 三、表情族

**标签**：#11/#26（smile_open_mouth）、#20/#32（sleepy 系）、#27/#33/#44/#49（blush）、#39（surprised_tearful）、#43（content_smile_closed_mouth）、#48（gentle_smile）、#57（dazed_thinking）

| 标签语义 | CDI3 候选参数 | 对应性评估 |
| --- | --- | --- |
| 张口笑 smile_open_mouth | `EyeSmile`（微笑）？ | ⚠️ EyeSmile 语义是"眼角笑"，与"张口"不完全重合；口形开合参数未定位（可能无独立参数，靠 mesh 变形）→ **须探针** |
| 困倦/呆滞 sleepy、dazed_thinking | `Param11`（呆滞 [0,8]，8 档） | ✅ dazed_thinking ↔ Param11 已有 batch-2 桥接线索；**sleepy 系标签是否对应 Param11 低档位待确认** |
| 脸红 blush ×4 | 无直接"脸红"命名参数 | ❓ 候选：`Param12/13`（生气1/2）不吻合；或纯贴图切换无参数 → **须逐参数探针**，不得凭名推断 |
| 惊讶落泪 surprised_tearful | `LCry/LCry3/LCryKey`（落泪族）、`Param132/133`（泪花A/B）、`Param27-29`（流泪膨胀/滴下） | ⚠️ 落泪族吻合，"惊讶"成分无对应命名 → 组合动作候选（落泪 + 待定惊讶表现） |
| 生气（无标签，Phase 3 计划动作） | `Angry`×3、`AngryMove`×8、`Param12/13`（生气1/2） | 🚫 **用户特别警示项**：AngryMove1-8（生气移动/伸缩/伸缩2/显隐）从命名看是生气特效部件的运动分量（移动/缩放/显隐），**但其组合行为（哪个是总开关、哪个是相位、方向约定）无法从名称确定**。注入测试必须先做单参数基线探针（逐个拉满观察渲染变化），再组合 |

**同族一致性**：blush 4 条同名同值跨 4 素材 ✅；smile_open_mouth 2 条（#11 source_exact / #26 inferred，争议组 6）⚠️。

## 四、身体动作 / 姿态族（pose 系）

**标签**：#10（three_view_standing）、#14（three_view_chibi_standing）、#22（lying_on_bed）、#28（hand_raised_pinch）、#34（both_palms_raised）、#42（hugging）、#45（hand_near_cheek）、#50（hand_to_cheek）、#60（head_pat_interaction_plush）

| 标签 | CDI3 候选 | 对应性评估 |
| --- | --- | --- |
| standing 系 ×2 | 多为静态姿势（Live2D 无骨骼姿态参数），候选 `BodyX/BodyZ/BodyAngle*` 族 | ⚠️ 三视图站姿是插画构图描述，非运行时姿态——建议裁决为**参考类标签**（不进动作库），或映射到身体倾角参数做"回正"校准用 |
| 卧床/举手/托手/拥抱 ×5 | 无直接对应参数 | ❓ 多为插画构图；候选联动：`hand_near_cheek`/`hand_to_cheek` 两标签语义几乎相同（#45/#50）——**同族命名一致性问题：应统一为一个值**（如 hand_to_cheek），裁决时二选一 |
| head_pat_interaction_plush (#60) | 玩实体化互动视频，无参数对应 | ℹ️ 实拍玩偶素材，参考类 |
| loading_spinner_single_shot (#58) | 候选：头顶特效部件（如 LittleFlower 族同机制） | ⚠️ conf=0.7（61 条中最低），素材为呆滞脸+头顶转圈——与 #57 同素材，特效部件待定位 |

## 五、非动作类标签（style/scene/outfit/color/other，共 17 条）

#3/#17/#41/#47（maid_headdress）、#4（long_wavy_hair）、#5/#18/#36（whale_embroidery）、#6/#52（blue_bow_accessories）、#7/#23/#29/#40/#51（outfit 系）、#8/#9、#12/#13/#19/#55（style/color）、#25/#56/#38（scene）、#31/#46/#37/#59/#61

这些是角色设定/画风/场景描述，**不参与动作桥接**，复核标准仅"语义是否准确"。

---

## 六、同族命名一致性问题清单（复核时须裁决）

| # | 问题 | 涉及标签 | 建议 |
| --- | --- | --- | --- |
| N1 | `hand_near_cheek`(#45) vs `hand_to_cheek`(#50) 语义重复 | 2 条 | 统一为一个规范值（原始名称保留在 evidence） |
| N2 | `sleepy_half_lidded`(#20) vs `sleepy_half_lidded_smile`(#32) | 2 条 | 两个不同表情（无笑/带笑），建议保留两个值但确认拆分标准 |
| N3 | `navy_maid_dress`(#7/#40) vs `navy_maid_dress_short_with_thighhighs`(#23) vs `navy_maid_dress_detached_sleeves`(#51) | 5 条 | 母值+变体结构合理；确认是否统一母值口径 |
| N4 | `chibi_dog_tail_grass_wave`(#53) 的 motion_cue 值含 `dog_tail_grass`（狗尾草）但动作实际是**挥动狗尾草道具**而非尾巴动作 | 1 条 | ⚠️ 命名易误导（"tail"指道具名），桥接已正确指向 Movement1，复核时确认语义注释清晰 |

## 七、AngryMove1–8 特别审计项（用户裁决警示）

| 参数 | cdi3 名 | 范围 | 名称可推断性 |
| --- | --- | --- | --- |
| AngryMove | 生气移动 | [0,1] | 低（"移动"= 位移？何种部件？） |
| AngryMove2/4/6/7 | 生气伸缩 / 生气伸缩2 | [-1,1] | 低（伸缩=缩放？±方向约定未知） |
| AngryMove3/8 | 生气显隐 | [0,1] | 中（显隐=透明度/可见性，较明确） |
| AngryMove5 | 生气移动 | [0,1] | 低（与 AngryMove 同名，角色分工未知） |

**强制流程**：Phase 3 注入测试前，须对 8 个参数逐个做**单参数基线探针**（渲染运行时拉满观察），记录实际视觉效果到 motion_analysis，之后才允许组合注入。本阶段不预设任何映射。

## 八、人工决策清单（61 条 = 61 个 decide）

全部 61 条均为 `needs_review`。执行方式：

```bash
node tools/gallery-schema/review.mjs list                 # 逐页查看
node tools/gallery-schema/review.mjs decide <id> approved --note "理由"
node tools/gallery-schema/review.mjs decide <id> rejected --note "理由"
```

裁决后状态不可覆写（repo 层 CASE 守卫已加固）。建议裁决顺序：先第五节非动作类（争议最小）→ 尾巴族 → 耳朵族 → 表情族 → pose 族（N1 命名问题在此裁决）。

## 九、裁决建议层（2026-11-05 通宵审计 · 仅供人工裁决参考，不代批）

> 纪律：本节是**建议**，不是决定。所有 approved 仍须你逐条 `review.mjs decide` 落库。
> 新增证据类型说明：`probe_numeric` = 真实运行时单参探针（probe_run 5–20，参数确实存在且可动、可恢复）；
> `cdi3` = cdi3 显示名静态证据；`visual_pending` = 视觉语义归因尚缺（须 GLM 多模态 QA 或你亲眼确认）。

### 9.1 可判（静态证据 + 数值探针齐备，建议 approved）

| 标签 | 建议 | 依据 |
|---|---|---|
| #53 狗尾草↔Movement1 | approved | cdi3 名"1. 狗尾草" source_exact；动作组"狗尾巴草打开/关闭"真实存在 |
| 尾巴族 4 条 whale_tail（Rotation84–87/Clothes5/Param52 通道描述） | approved | cdi3 [0]~[3]尾巴/5.尾巴/尾巴翻面 + probe_run 5–8 数值证据；**注意**：只证"参数存在且可动"，"该标签对素材视觉描述正确"仍属 visual_pending——若严格口径则同 9.2 |

### 9.2 须探针/视觉归因后才能判（保留 needs_review + 所缺证据）

| 标签 | 所缺证据 |
|---|---|
| #2/#16/#30 whale_fin_ears（耳族） | LEar/REar1–3 已 probe_numeric（存在/可动/恢复），但"鲸鳍耳发翼是否由此参数驱动"缺**视觉归因**——探针截图已存 `data/runtime-probe/`，待 GLM 多模态比对 |
| blush / smile_open_mouth / dazed_thinking | blush 无直接参数；smile_open_mouth≠EyeSmile；dazed_thinking↔Param11 有线索——均缺视觉归因 |
| AngryMove1–8 相关 8 组 | 单参探针全 PASS（数值层），但 8 参数各自的实际视觉效果未归因——**不得组合进正式桥接** |
| pose 族（含 N1 hand_near_cheek/hand_to_cheek 重复） | 先裁决 N1 命名统一，再逐条判 |
| 非动作类 17 条 | 语义不涉参数映射，按素材事实判即可（争议最小） |

### 9.3 建议裁决顺序（更新）

1. 第五节非动作类 17 条（无参数依赖）
2. #53 + 尾巴族 4 条（9.1 表）
3. 耳族 3 条 → 等 GLM 视觉归因
4. 表情族 → 同上
5. pose 族（N1 先行）
6. AngryMove 相关 8 组（单参视觉归因报告产出后）
