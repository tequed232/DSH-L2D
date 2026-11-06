# CODE-REVIEW-2 缺陷清单（只读审查）

- 审查人：bug-hunter-2 / 分支 feat/model-registry / HEAD=76ee5b5
- 范围：本轮新增 6 组代码（Observer / Matcher / Gallery-Bridge / schema v9-v10 / dev-server /api/actions / score.mjs）及配套测试
- 严重级：中级 = 会造成数据错误或崩溃；低级 = 边界或可维护性

## 缺陷明细

### M1 gallery-source.mjs:34 — 默认 fsImpl 返回 Promise，非注入时附图功能整体失效 【中级】
默认实现 `readFileSync: (p) => import('node:fs').then((m) => m.readFileSync(p))` 返回的是 **Promise 而非 Buffer**。`top()` 中 `buf = fs.readFileSync(...)`（gallery-source.mjs:47）拿到 Promise 后：`sniffMime(Promise)` 返回 null → 所有图片一律判 `fileMissing`；且异步 rejection 发生在 try/catch 之外，成为 unhandled rejection。当前所有测试都注入了 `fsImpl: fs`，完全掩盖了该缺陷。生产装配（后续桥接宿主）只要忘记注入 fsImpl，附图功能即静默全灭。
建议：默认实现改为同步 `createRequire(import.meta.url)('node:fs').readFileSync`，或顶部直接 `import fs from 'node:fs'`（依赖注入仅保留测试覆盖入口）。

### M2 tools/gallery-schema/score.mjs:48,86-96 — vision 缺 body/clarity 字段 → score=NaN，视觉分静默丢失 【中级】
draft 读取守卫只校验 `vision.expression`（第 48 行），合成公式 `0.4*expression + 0.4*body + 0.2*clarity` 中 body/clarity 缺失时得 NaN → `vision.total = NaN`（第 87 行，且被写回 draft 污染后续增量合成）→ `score = Math.round(0.4*base + 0.6*NaN) = NaN` → `CLAMP(NaN,0,100)` 仍为 NaN → `JSON.stringify` 把 NaN 序列化为 null → 导入脚本 `Number.isFinite(it.score)` 过滤，该条**静默不导入**，无任何告警。
建议：守卫补齐 `Number.isFinite(vision.body) && Number.isFinite(vision.clarity)`，不完整即按纯规则分处理并计入 anomalies。

### M3 tools/gallery-schema/score.mjs:121 — draft JSON 非原子写，崩溃即丢失全部视觉分明细 【中级】
`writeFileSync(DRAFT_PATH, ...)` 直接覆盖唯一数据文件：进程中途崩溃 / 磁盘满 → draft JSON 截断损坏 → 下次运行解析失败按「空 draft」处理（score.mjs:42-44 仅 warn）→ 输出全量规则分**覆盖写回**，已积累的视觉分明细永久丢失（vision 打分是外部 Agent 的昂贵产物）。
建议：先写 `DRAFT_PATH.tmp` 再 `renameSync` 原子替换；解析失败时拒绝覆盖写（fail-fast 而非按空重置）。

### M4 packages/mcp-bridge/observer.mjs:160-173 — stop()/dispose() 无法真正停轮，观察器生命周期泄漏 【中级】
`start()` 的回调在 poll 完成后于 `finally` 中无条件 `this.start()` 重新排程，且 poll 在途期间 `this.timer` 仍是已触发 timer 的旧 id。此时调用 `stop()`：`clearTimeout` 对已触发 timer 无效，`finally` 随后仍重启轮询——观察器**永远停不下来**，宿主卸载/工作区销毁后仍持续轮询并可能继续调度事件。
建议：增加 `this.stopped` 标志，`stop()` 置位；`finally` 中先检查标志再决定是否 `start()`。

### L1 packages/mcp-bridge/action-matcher.mjs:159,162,229 — cache.stats 访问守卫不一致 【低级】
第 154 行只校验 `typeof cache.get === 'function'`，但命中/未命中路径直接 `options.cache.stats.hits += 1`（159/162 行）——注入有 get/set 而无 stats 的自定义 cache 时抛 TypeError；而第 229 行又以 `options.cache.stats &&` 条件判断 set。同一对象两种假设并存：无 stats 的 cache 要么崩、要么静默不缓存。
建议：统一在 154 行校验 `stats` 形状，或访问处全部改为可选链。

### L2 packages/mcp-bridge/action-matcher.mjs:147-150 — matchThreshold 只覆盖 adopt，compat 恒为 0.65 【低级】
`local.matchThreshold` 配置 < 0.65 时，compat 分支区间 [0.65, adopt) 为空 → compat 永不可达，0.65~adopt 分数全部落入 adopt 分支按「采用」处理，配置语义静默变形且无文档。
建议：compat 随 adopt 联动（如 `compat = min(0.65, adopt)`）或在 settings 校验 adopt > compat 时告警。

### L3 packages/mcp-bridge/observer.mjs:162-166,232 — poll 异常静默吞掉；单工作区 DB 故障中断整轮 【低级】
`start()` 的 `.catch(() => {})` 吞掉 poll 全部异常（source 抛错、dedup 库故障），无 log、无 stats 计数，连续失败无从察觉。且 `dispatchOnce` 中 `recordDispatchPending`（232 行）抛错未被 per-workspace 捕获，异常上抛中断整轮 for 循环，排在其后的工作区事件全部延后一轮。
建议：catch 里至少 `this.log` + 计入 stats；循环体内对单个 snap 的 dispatchOnce 加 try/catch 隔离。

### L4 packages/mcp-bridge/import-gallery-scores.mjs:113-115 — 空 catch 把一切异常归为 FK 拒绝 【低级】
`catch { skippedFk++ }` 吞掉全部异常：schema 不匹配、磁盘 I/O、repo 实现错误都被计入 skippedFk，与真 FK 拒绝不可区分，导入静默漏数且误导统计口径。
建议：catch (err) 打印 err.message 计入独立的 skippedError，或至少对非 SqliteError 类型重抛。

### L5 tools/dev-server/index.mjs:441-447 — /api/actions 每请求重开连接 + 全量重查，空集与故障不可区分 【低级】
每请求 `new DatabaseSync(..., {readOnly})` 开新连接、无缓存全量重查（overlay 高频轮询下开销线性放大）；外层 `catch {}` 把 SQL 语义错误也降级为空集。属既定降级策略（注释已明示）且 SQL 全部参数化绑定（74 行 `?` 绑定，无注入面；env 覆写 `DSH_L2D_ACTIONS_MODEL_ID` 仅作绑定参数，安全）。列低级备忘：建议加 TTL 内存缓存（如 30s）。
另注：连接生命周期正确（finally db.close()），无泄漏。

### L6 tools/gallery-schema/score.mjs:98-99 — file_missing 只记 anomalies，不影响分数且导入侧不消费 【低级】
`file_missing` 仅写入 draft 异常清单，score 照常计算、导入脚本照常 upsert 入库——缺失文件的图带分进入 top-N 池，靠读侧 gallery-source 兜底标 fileMissing。若 GALLERY_DIR 配置漂移（默认硬编码 `D:/Temp/l2d-gallery-extract/`，第 15 行），可能出现大面积误判。
建议：导入脚本跳过 `file_missing: true` 条目或至少告警；GALLERY_DIR 默认值改为相对仓库路径。

### L7 packages/mcp-bridge/tests/gallery-bridge.test.mjs:5 — 文件头注释与实现不符 【低级】
头注释仍写「matcher 命中附图（score>60）」，实现已是 ≥30 底线（测试断言本身正确）。过期注释会误导后续维护者。
建议：更新为「score≥30 底线」。

### L8 packages/dsh-l2d-db/src/gallery-repo.mjs:67 — limit 边界：0/负数回退为 3 而非报错 【低级】
`Number.isInteger(limit) && limit > 0 ? Math.min(limit,3) : 3`：调用方传 `limit: 0` 或负数时静默返回 3 条，与「上限 clamp」语义不符（0 应返回空集）。matcher 内部传 1/3 不受影响。
建议：`limit <= 0` 显式返回空数组。

## 无缺陷文件

- packages/dsh-l2d-db/src/observer-repo.mjs — 无缺陷（INSERT OR IGNORE 抢占、状态单向推进、attempts 递增、attempts/last_error 语义正确）
- packages/dsh-l2d-db/src/schema.mjs v9/v10 迁移段 — 无缺陷（迁移经 withTransaction 串行应用、失败回滚且不写 schema_migrations、重复打开幂等；v10 FK→gallery_items(id)、score CHECK [0,100] 完整；prompt_templates 主键为 template_id，与 seedMotionDirectorTemplate 的 ON CONFLICT(template_id) 匹配，已核对）
- packages/mcp-bridge/tests/observer.test.mjs — 无缺陷（断言与实现语义一致，含老化/互斥/崩溃恢复/优先级回归）
- packages/mcp-bridge/tests/matcher.test.mjs — 无缺陷（0.85/0.65 边界、同分决胜、负面用例与实现口径一致）

## 统计

**中 4 / 低 8**（共 12 条；M1-M4 建议随下轮修复批处理，其中 M1/M2/M3 影响数据正确性优先级最高）
