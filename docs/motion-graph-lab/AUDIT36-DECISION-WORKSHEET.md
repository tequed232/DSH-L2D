# AUDIT36 裁决辅助工作表（issue #36 · 61 条标签人工逐条 decide）

- 生成：2026-11-11，由审计辅助代理整理（**只读汇编，未修改任何标签状态，未做任何裁决**）
- 材料来源：
  - `docs/REVIEW-LIST-RAW-2026-11-05.txt`（61 条原始清单，全部 `needs_review`）
  - `docs/LABEL-AUDIT-CLASSIFIED.md`（§九为裁决建议层，**不代批**）
  - `docs/ANGRYMOVE-OBSERVATION-DRAFT.md`（AngryMove1–8 初筛记录）
  - 截图证据目录：`data/runtime-probe/`
- 数量核对：本表共 **61 条**（P0 冲突项 19 + P1 建议存疑项 17 + P2 明确项/非动作类 25 = 61 ✓）

---

## 0. 操作指引（必读）

1. **用户逐条填写**下方表格最后一列 `decide`，只能填：`keep`（维持现值）/ `reclassify`（需改值/改名）/ `block`（挂起，证据不足）。可在行内加备注。
2. **禁止凭标签名称批量推断语义**（issue 原文要求，尤其 AngryMove1-8——参数名"生气移动/伸缩/显隐"不等于实际视觉效果）。
3. 用户 decide 后，由**主理人经 Repository 唯一写入口**落库：

   ```bash
   node tools/gallery-schema/review.mjs list                 # 逐页查看
   node tools/gallery-schema/review.mjs decide <id> approved --note "理由"
   node tools/gallery-schema/review.mjs decide <id> rejected --note "理由"
   ```

   裁决后状态不可覆写（repo 层 CASE 守卫已加固）。
4. 全部 61 条落库后，issue #36 闭环。
5. `decide` 列（keep/reclassify/block）到 `review.mjs decide`（approved/rejected/保留 needs_review）的具体映射由主理人确认执行，本工作表不代行。

> 纪律声明：§九建议层原文摘录仅供参考，本表不做任何 approved/reject 决策。材料中没有的建议一律写「无 §九 逐条建议」，不编造。

---

## 1. P0 冲突项（19 条 · 优先裁决）

判定依据：同族跨素材证据不一致（争议组）或同族命名冲突（§六 N1–N4）。

| # | 标签名 | 类别 | 证据等级/conf | 当前审计分类 | §九建议（原文摘录） | 证据引用 | decide（keep/reclassify/block） |
|---|---|---|---|---|---|---|
| 1 | whale_tail | part | source_exact / 0.80 | 冲突·争议组1（whale_tail 4 条跨素材同名，conf 极差 0.15，证据等级 mixed）；桥接参数已落 Hard/Soft 双层边界 | 9.1 建议 approved（probe_run 5–8 数值证据）；**注意**：只证"参数存在且可动"，"该标签对素材视觉描述正确"仍属 visual_pending——若严格口径则同 9.2 | `dafeiyu-mature-character-sheet.png`（三视图-侧面/背面：蓝色鲸尾鳍）；cdi3：`Clothes5`"5.尾巴"、`Param52`"尾巴翻面"、`Param_Angle_Rotation84–87`"[0]~[3]尾巴"；截图 `data/runtime-probe/baseline-Param_Angle_Rotation84~87*.png` | |
| 15 | whale_tail | part | inferred / 0.95 | 同上（争议组1） | 同上 | `HTMmWmCaYAAilyN.jpg`（batch-1-2026-11-04） | |
| 24 | whale_tail | part | inferred / 0.90 | 同上（争议组1） | 同上 | `bili_poster-1791382745061.png`（batch-1-2026-11-04） | |
| 35 | whale_tail | part | inferred / 0.85 | 同上（争议组1） | 同上 | `HUokZsIbgAAKJZJ.jpg`（batch-1-2026-11-04） | |
| 2 | whale_fin_ears | part | source_exact / 0.80 | 冲突·耳族争议（3 条同名同值，source_exact vs inferred，属 8 组争议项之一） | 9.2：LEar/REar1–3 已 probe_numeric（存在/可动/恢复），但"鲸鳍耳发翼是否由此参数驱动"缺**视觉归因**——探针截图已存 `data/runtime-probe/`，待 GLM 多模态比对 | `dafeiyu-mature-character-sheet.png`（头部两侧：鲸鳍状耳发翼）；cdi3：`LEar/REar1-3`（兽耳PHA/B/C）；截图 `baseline-LEar1~3*.png`、`baseline-REar1~3*.png`；人工决策点：耳发翼可动→可桥接 `ear_move`；不可动→降级纯外观描述 | |
| 16 | whale_fin_ears | part | inferred / 0.95 | 同上（耳族争议） | 同上 | `HTMmWmCaYAAilyN.jpg`（batch-1-2026-11-04） | |
| 30 | whale_fin_ears | part | inferred / 0.85 | 同上（耳族争议） | 同上 | `heybox_1792638467783_-1242029457.png`（batch-1-2026-11-04） | |
| 11 | smile_open_mouth | expression | source_exact / 0.80 | 冲突·争议组6（#11 source_exact vs #26 inferred） | 9.2：缺视觉归因（`EyeSmile` 语义是"眼角笑"≠"张口"；口形开合参数未定位，可能靠 mesh 变形——须探针） | `dafeiyu-mature-character-sheet.png`（正面+细节窗1：张口笑） | |
| 26 | smile_open_mouth | expression | inferred / 0.90 | 同上（争议组6） | 同上 | `heybox_1792638467783_-1242029457.png`（batch-1-2026-11-04） | |
| 45 | hand_near_cheek | pose | inferred / 0.90 | 冲突·N1 命名重复（与 #50 语义几乎相同） | 9.2：pose 族先裁决 N1 命名统一，再逐条判（§六建议统一为一个规范值，原始名称保留在 evidence） | `IMG_20261007_220618_CROP.jpg`（batch-1-2026-11-04） | |
| 50 | hand_to_cheek | pose | inferred / 0.90 | 同上（N1，二选一统一） | 同上 | `ChatGPT 截图 2026年10月3日 15_49_09.png`（batch-1-2026-11-04，文件名编码乱码见 RAW 清单） | |
| 20 | sleepy_half_lidded | expression | inferred / 0.85 | 冲突·N2（与 #32 拆分标准待确认） | §六建议保留两个值但确认拆分标准；§三：sleepy 系是否对应 `Param11`（呆滞 [0,8]）低档位待确认；无 §九 逐条建议（表情族统一等视觉归因） | `bili_poster-1791382745061.png`（batch-1-2026-11-04） | |
| 32 | sleepy_half_lidded_smile | expression | inferred / 0.90 | 同上（N2） | 同上 | `HUokZsIbgAAKJZJ.jpg`（batch-1-2026-11-04） | |
| 7 | navy_maid_dress | outfit | source_exact / 0.80 | 冲突·N3 口径确认（母值+变体结构） | §六：确认是否统一母值口径；无 §九 逐条建议（outfit 非动作类） | `dafeiyu-mature-character-sheet.png`（三视图-正面：深蓝女仆装+金线纹样） | |
| 40 | navy_maid_dress | outfit | inferred / 0.90 | 同上（N3） | 同上 | `HTRat8FXUAAl484.jpg`（batch-1-2026-11-04） | |
| 23 | navy_maid_dress_short_with_thighhighs | outfit | inferred / 0.85 | 同上（N3 变体） | 同上 | `bili_poster-1791382745061.png`（batch-1-2026-11-04） | |
| 29 | dark_maid_variant_grey_apron | outfit | inferred / 0.80 | 同上（N3 变体） | 同上 | `heybox_1792638467783_-1242029457.png`（batch-1-2026-11-04） | |
| 51 | navy_maid_dress_detached_sleeves | outfit | inferred / 0.85 | 同上（N3 变体） | 同上 | `ChatGPT 截图 2026年10月3日 15_49_09.png`（batch-1-2026-11-04） | |
| 53 | chibi_dog_tail_grass_wave | motion_cue | parser_derived / 0.85 | 冲突·N4 命名易误导（"tail"指狗尾草道具名，非尾巴动作）；桥接已正确指向 `Movement1` | 9.1 建议 approved：cdi3 名"1. 狗尾草" source_exact；动作组"狗尾巴草打开/关闭"真实存在（E2E 验证）；复核时确认语义注释清晰 | `1790571183144.gif`（batch-2-2026-11-04-gif-motion：Q版持狗尾草挥动，夜空背景）；cdi3：`Movement1`"1. 狗尾草" | |

---

## 2. P1 建议存疑项（17 条 · 须探针/视觉归因后判）

判定依据：§9.2/§9.3 明确"须探针/视觉归因后才能判"，或 §三/§四 评估标 ⚠️/❓ 且无 §九 逐条建议。

| # | 标签名 | 类别 | 证据等级/conf | 当前审计分类 | §九建议（原文摘录） | 证据引用 | decide（keep/reclassify/block） |
|---|---|---|---|---|---|---|
| 27 | blush | expression | inferred / 0.80 | 存疑·表情族（缺视觉归因） | 9.2：blush 无直接参数；候选 `Param12/13`（生气1/2）不吻合；或纯贴图切换无参数——须逐参数探针，不得凭名推断 | `heybox_1792638467783_-1242029457.png`；§三：blush 4 条同名同值跨 4 素材 ✅ | |
| 33 | blush | expression | inferred / 0.85 | 同上 | 同上 | `HUokZsIbgAAKJZJ.jpg` | |
| 44 | blush | expression | inferred / 0.85 | 同上 | 同上 | `IMG_20261007_220618_CROP.jpg` | |
| 49 | blush | expression | inferred / 0.85 | 同上 | 同上 | `ChatGPT 截图 2026年10月3日 15_49_09.png` | |
| 57 | dazed_thinking | expression | source_exact / 0.90 | 存疑·表情族（Param11 有线索，缺视觉归因） | 9.2：dazed_thinking↔`Param11`（呆滞 [0,8]，8 档）有 batch-2 桥接线索——缺视觉归因 | `27260cb26da951ab70f83962775ec1579bd0e52d8885184725abc160ec3bd31b.gif`（呆滞脸+口水+思考气泡"正在思考..."） | |
| 39 | surprised_tearful | expression | inferred / 0.85 | 存疑·表情族 | 无 §九 逐条建议（§9.3-4 表情族统一等视觉归因）；§三评估：落泪族 `LCry/LCry3/LCryKey`/`Param132/133`/`Param27-29` 吻合，"惊讶"成分无对应命名→组合动作候选 | `HTRat8FXUAAl484.jpg` | |
| 21 | finger_on_lips | expression | inferred / 0.80 | 存疑·表情族 | 无 §九 逐条建议（§三未单列；§9.3-4 表情族统一等视觉归因） | `bili_poster-1791382745061.png` | |
| 43 | content_smile_closed_mouth | expression | inferred / 0.90 | 存疑·表情族 | 无 §九 逐条建议（§9.3-4 表情族统一等视觉归因） | `IMG_20261007_220618_CROP.jpg` | |
| 48 | gentle_smile | expression | inferred / 0.90 | 存疑·表情族 | 无 §九 逐条建议（§9.3-4 表情族统一等视觉归因） | `ChatGPT 截图 2026年10月3日 15_49_09.png` | |
| 10 | three_view_standing | pose | source_exact / 0.80 | 存疑·pose 族（参考类候选） | 无 §九 逐条建议（§9.3-5 pose 族逐条判）；§四评估：三视图站姿是插画构图描述非运行时姿态——建议裁决为**参考类标签**（不进动作库），或映射 `BodyX/BodyZ/BodyAngle*` 做回正校准用 | `dafeiyu-mature-character-sheet.png`（正/侧/背三视站姿） | |
| 14 | three_view_chibi_standing | pose | source_exact / 1.00 | 存疑·pose 族（参考类候选） | 同上 | `HTMmWmCaYAAilyN.jpg`（batch-1-2026-11-04，gallery-static-art-v1） | |
| 22 | lying_on_bed | pose | inferred / 0.90 | 存疑·pose 族 | 无 §九 逐条建议（§9.3-5）；§四评估：无直接对应参数，多为插画构图 | `bili_poster-1791382745061.png` | |
| 28 | hand_raised_pinch | pose | inferred / 0.85 | 存疑·pose 族 | 同上 | `heybox_1792638467783_-1242029457.png` | |
| 34 | both_palms_raised | pose | inferred / 0.90 | 存疑·pose 族 | 同上 | `HUokZsIbgAAKJZJ.jpg` | |
| 42 | hugging | pose | inferred / 0.90 | 存疑·pose 族 | 同上 | `HTRat8FXUAAl484.jpg` | |
| 58 | loading_spinner_single_shot | motion_cue | parser_derived / 0.70 | 存疑·特效部件待定位（conf=0.70 为 61 条中最低） | 无 §九 逐条建议；§四评估：候选头顶特效部件（如 LittleFlower 族同机制），与 #57 同素材 | `27260cb26da951ab70f83962775ec1579bd0e52d8885184725abc160ec3bd31b.gif`（头顶加载转圈图标） | |
| 60 | head_pat_interaction_plush | motion_cue | parser_derived / 0.75 | 存疑·参考类 | 无 §九 逐条建议；§四评估：实拍玩偶素材，参考类 | `1791949382162.gif`（真实玩偶被手摸头，Q版女仆造型实体化） | |

---

## 3. P2 明确项 / 非动作类（25 条 · 争议最小）

判定依据：§五"角色设定/画风/场景描述，不参与动作桥接，复核标准仅『语义是否准确』"；§9.3-1 建议最先裁决。

| # | 标签名 | 类别 | 证据等级/conf | 当前审计分类 | §九建议（原文摘录） | 证据引用 | decide（keep/reclassify/block） |
|---|---|---|---|---|---|---|
| 3 | maid_headdress | part | source_exact / 0.80 | 非动作类 | 9.2：语义不涉参数映射，按素材事实判即可（争议最小） | `dafeiyu-mature-character-sheet.png`（头顶：白色荷叶边头饰） | |
| 17 | maid_headdress | part | inferred / 0.95 | 非动作类 | 同上 | `HTMmWmCaYAAilyN.jpg` | |
| 41 | maid_headdress | part | inferred / 0.90 | 非动作类 | 同上 | `HTRat8FXUAAl484.jpg` | |
| 47 | maid_headdress | part | inferred / 0.90 | 非动作类 | 同上 | `IMG_20261007_220618_CROP.jpg` | |
| 4 | long_wavy_hair | part | source_exact / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png`（全身：蓝色长卷发，背面过腰） | |
| 5 | whale_embroidery | part | source_exact / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png`（细节窗2：围裙上的鲸鱼刺绣） | |
| 18 | whale_embroidery | part | inferred / 0.90 | 非动作类 | 同上 | `HTMmWmCaYAAilyN.jpg` | |
| 36 | whale_embroidery | part | inferred / 0.90 | 非动作类 | 同上 | `HUokZsIbgAAKJZJ.jpg` | |
| 6 | blue_bow_accessories | part | source_exact / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png`（头部/胸前/背部：多处蓝色蝴蝶结） | |
| 52 | blue_bow_accessories | part | inferred / 0.90 | 非动作类 | 同上 | `ChatGPT 截图 2026年10月3日 15_49_09.png` | |
| 8 | white_apron | outfit | source_exact / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png`（三视图-正面：双层荷叶边围裙） | |
| 9 | white_tights_black_shoes | outfit | source_exact / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png`（细节窗6：白袜+黑玛丽珍高跟鞋） | |
| 12 | navy_white_blue_palette | color | inferred / 0.90 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png` | |
| 13 | anime_soft_shading | style | inferred / 0.80 | 非动作类 | 同上 | `dafeiyu-mature-character-sheet.png` | |
| 19 | chibi | style | inferred / 0.95 | 非动作类 | 同上 | `HTMmWmCaYAAilyN.jpg` | |
| 55 | chibi | style | source_exact / 0.95 | 非动作类 | 同上 | `1790571183144.gif`（Q版二头身） | |
| 25 | bedroom | scene | inferred / 0.90 | 非动作类 | 同上 | `bili_poster-1791382745061.png` | |
| 56 | night_sky | scene | source_exact / 0.80 | 非动作类 | 同上 | `1790571183144.gif`（深蓝夜空背景带星点） | |
| 38 | group_shot_deepseek_cast | scene | inferred / 0.95 | 非动作类 | 同上 | `HTRat8FXUAAl484.jpg` | |
| 59 | speech_bubble_text | scene | source_exact / 0.85 | 非动作类 | 同上 | `27260cb26da951ab70f83962775ec1579bd0e52d8885184725abc160ec3bd31b.gif`（"正在思考……"原文带引号摘录入册） | |
| 37 | speech_bubble_text | other | source_exact / 1.00 | 非动作类 | 同上 | `HUokZsIbgAAKJZJ.jpg` | |
| 31 | blue_crystal_brooch | part | inferred / 0.85 | 非动作类 | 同上 | `heybox_1792638467783_-1242029457.png` | |
| 46 | flower_iris_highlight | part | inferred / 0.90 | 非动作类 | 同上 | `IMG_20261007_220618_CROP.jpg` | |
| 61 | chibi_plush_doll | part | source_exact / 0.90 | 非动作类 | 同上 | `1791949382162.gif`（实拍玩偶：女仆装+鲸鳍耳发+蓝白配色） | |
| 54 | chibi_dog_tail_grass_prop | part | source_exact / 0.90 | 非动作类（桥接一致性 ✅） | 无 §九 逐条建议；§二评估：与 `Movement1`（道具存在性）桥接一致 | `1790571183144.gif`（手持道具：狗尾草） | |

> 源材料口径备注：`LABEL-AUDIT-CLASSIFIED.md` §五标题写"共 17 条"，但其列举的 id 实为 29 个（含 part 类外观部件）。本表按 §五列举 id 全部收录为非动作类（去重后 24 条）+ §二明确 ✅ 的 #54 = 25 条。标题计数与列举不一致系源文档原文如此，口径待主理人裁定，本表未擅自修改。

---

## 4. AngryMove1–8 特别审计节（参数级，非 61 条标签 · 用户特别警示项）

**模型级 `runtime_verified` 刻意未设**（V7 视觉归因 BLOCKED，等多模态 QA）。初筛材料：`docs/ANGRYMOVE-OBSERVATION-DRAFT.md`。

### 4.1 参数定义（cdi3 显示名 · `_test-models/deepseek/大肥鱼.cdi3.json` ParamGroup17）

| 参数 | cdi3 显示名 | 范围（LABEL-AUDIT §七） | 名称可推断性 | 初筛可见变化 | 视觉归因状态 |
|---|---|---|---|---|---|
| AngryMove | 生气移动 | [0,1] | 低 | **胸前丝带处出现蓝色小符号**（疑似生气符号/挂件显隐） | ✅ 已截图，待多模态复核 |
| AngryMove5 | 生气移动 | [0,1] | 低（与 AngryMove 同名，角色分工未知） | **胸前出现蓝色小符号（与 AngryMove 类似）** | ✅ 已截图，待多模态复核 |
| AngryMove2 | 生气伸缩 | [-1,1] | 低（伸缩=缩放？±方向约定未知） | 头部窗内无可见差异 | ❌ 待补证（需全身窗对照） |
| AngryMove3 | 生气显隐 | [0,1] | 中（显隐较明确） | 头部窗内无可见差异 | ❌ 待补证 |
| AngryMove4 | 生气伸缩2 | [-1,1] | 低 | 头部窗内无可见差异 | ❌ 待补证 |
| AngryMove6 | 生气伸缩 | [-1,1] | 低 | 头部窗内无可见差异 | ❌ 待补证 |
| AngryMove7 | 生气伸缩2 | [-1,1] | 低 | 头部窗内无可见差异 | ❌ 待补证 |
| AngryMove8 | 生气显隐 | [0,1] | 中 | 头部窗内无可见差异 | ❌ 待补证 |

### 4.2 截图证据清单（`data/runtime-probe/`，已实存核对）

**已有（齐全）**：
- 头部裁剪窗：`head-neutral.png` + `head-AngryMove.png` ~ `head-AngryMove8.png`（共 9 张，全齐）
- 全身前后对照（8 对全齐）：`pre-AngryMove-1793812905831.png` ↔ `baseline-AngryMove-1793812907832.png`；`pre-AngryMove2-1793812912260.png` ↔ `baseline-AngryMove2-1793812914285.png`；`pre-AngryMove3-1793812918745.png` ↔ `baseline-AngryMove3-1793812920784.png`；`pre-AngryMove4-1793812925200.png` ↔ `baseline-AngryMove4-1793812927254.png`；`pre-AngryMove5-1793812931728.png` ↔ `baseline-AngryMove5-1793812933778.png`；`pre-AngryMove6-1793812938243.png` ↔ `baseline-AngryMove6-1793812940252.png`；`pre-AngryMove7-1793812944697.png` ↔ `baseline-AngryMove7-1793812946747.png`；`pre-AngryMove8-1793812951261.png` ↔ `baseline-AngryMove8-1793812953300.png`
- 更早一轮（2026-11-05 03:40 初筛）：`baseline-AngryMove-1793811628353.png`、`baseline-AngryMove-1793811668899.png`、`baseline-AngryMove2~8-1793812*.png`（各 1–2 张）
- 数值层 JSON：`baseline-AngryMove-latest.json` ~ `baseline-AngryMove8-latest.json`（8/8 全齐；8/8 参数注入生效、超出基线噪声、基线恢复）

**缺失 / 待补证**：
1. **AngryMove2/3/4/6/7/8 共 6 个参数的可见效果证据**：初筛裁剪窗只覆盖头部与上胸，"无可见差异"≠"无效果"——效果可能在全身窗、身体下部、发型或缩放类，需全身对照 diff 补证。
2. **GLM 多模态复核产出**：AngryMove1–8 职责表（显隐/方向/缩放/相位）尚未产出（V7 BLOCKED）。
3. `head-AngryMove*.png` 逐张与 `head-neutral.png` 的特写对照结论尚未回填。

### 4.3 强制流程（LABEL-AUDIT §七 / 初筛稿 §GLM 复核要求）

- Phase 3 注入测试前，须对 8 个参数逐个做单参数基线探针（**数值层已全 PASS**：probe_run 6/14–20/21–28），实际视觉效果归因报告产出并经人工确认后，才允许组合注入。
- **本阶段不预设任何映射**；初筛"推断（不确定，勿采信）"列不作为归因依据。
- 复核通过前，怒链保持单参数（`motion.angry_flash_single`），不得组合进正式桥接（§9.2）。

---

## 5. 裁决执行顺序

任务口径（本表排序）：**P0 冲突项 → P1 建议存疑项 → P2 明确项**。

源材料 §9.3 备选口径（亦可采用）：① 非动作类（无参数依赖，争议最小）→ ② #53 + 尾巴族 4 条（9.1 表）→ ③ 耳族 3 条（等 GLM 视觉归因）→ ④ 表情族 → ⑤ pose 族（N1 先行）→ ⑥ AngryMove 相关 8 组（单参视觉归因报告产出后）。

两种顺序均以"人工逐条 decide、不批量修改"为前提，由用户选定其一执行。

---

## 6. 硬/软双层边界背景（schema v6 落地，与本表关联）

- 16 项 w3-registry vs moc3 二进制范围冲突已落双层边界（commit `74ce24c`）：**Hard = moc3 理论边界 / Soft = w3-registry 实测摆幅**，原始证据保留于 `validation_findings`。
- 案例：Param39 请求 1 → strict clamp 0.322（Soft Envelope），真实运行时闭环（`docs/OVERNIGHT-AUDIT-REPORT.md`）。
- 与本表关联：whale_tail 桥接参数（`Rotation84–87`/`Clothes5`/`Param52`）、耳族（`LEar/REar1-3`）、怒族（`AngryMove1-8`）的注入范围均受此双层边界约束；标签裁决只决定"标签语义/去留"，不改动参数边界。
