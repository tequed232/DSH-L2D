# Supervisor 数据模型（v8→v9 迁移方案）

> 依据：SUPERVISOR-DECREE.md §2/§3/§4/§10（禁新增表禁令对本文两表+Observer 查重表解除）。
> 承接 GAP-ANALYSIS.md。**本阶段只设计，不动 schema.mjs。**

## 1. v9 迁移 DDL（追加进 schema.mjs MIGRATIONS，风格对齐 v7/v8）

```sql
-- v9：Supervisor 情绪元数据 + Observer 查重（2026-11-0x，SUPERVISOR-DECREE §2/§4/§10）
--  - action_id 语义动作 = motion_definitions.id（Actions Lib 主键，沿用 v3 域）；
--  - expression 是语义描述（如 'smile'），执行期经 Model Profile 映射为具体
--    Expression ID / 参数——换模型只改映射，不重训 Bridge（裁决书 §4）；
--  - 标记工作承接 61 条标签审计（docs/LABEL-AUDIT-CLASSIFIED.md）：人工审计
--    流程逐条写 approved，禁止批量凭名称推断；needs_review 行不参与检索。
CREATE TABLE IF NOT EXISTS action_emotions (
  action_id      TEXT NOT NULL REFERENCES motion_definitions(id) ON DELETE CASCADE,
  emotion        TEXT NOT NULL,
  expression     TEXT NOT NULL,
  intensity      REAL CHECK (intensity IS NULL OR (intensity >= 0 AND intensity <= 1)),
  confidence     REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence_level TEXT NOT NULL DEFAULT 'inferred'
                 CHECK (evidence_level IN ('source_exact','parser_derived','inferred')),
  review_state   TEXT NOT NULL DEFAULT 'needs_review'
                 CHECK (review_state IN ('needs_review','approved','rejected')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (action_id, emotion, expression)
);
CREATE INDEX IF NOT EXISTS idx_action_emotions_lookup
  ON action_emotions (emotion, review_state, intensity);

-- chain_id = action_chains.id。标签词表开放（part/pose/style 均可），
-- 与 gallery_labels 人工审计同纪律：写入口唯一（Repository），拒绝经 pipeline 留痕。
CREATE TABLE IF NOT EXISTS action_chain_tags (
  chain_id      TEXT NOT NULL REFERENCES action_chains(id) ON DELETE CASCADE,
  tag           TEXT NOT NULL,
  evidence_level TEXT NOT NULL DEFAULT 'inferred'
                CHECK (evidence_level IN ('source_exact','parser_derived','inferred')),
  review_state  TEXT NOT NULL DEFAULT 'needs_review'
                CHECK (review_state IN ('needs_review','approved','rejected')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (chain_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_action_chain_tags_lookup
  ON action_chain_tags (tag, review_state);

-- Observer dispatchOnce 查重（裁决书 §2：bridge 层表）。事件登记+调度指令创建
-- 同事务写入；崩溃恢复按 (workspace_id, event_id) 重放判定，不漏调度。
CREATE TABLE IF NOT EXISTS observer_dispatch_log (
  workspace_id  TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'dispatched'
                CHECK (status IN ('dispatched','failed')),
  dispatched_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, event_id)
);
```

SCHEMA_VERSION 8→9（schema.mjs:28）。迁移纪律：只追加不改写、schema_migrations 门禁幂等（db.mjs migrate）。

## 2. 与 Actions JSON 入库规则 G0-G4 的兼容路径

- 写入口唯一：新表只经 Repository（新文件 supervisor-repo.mjs 或扩展 actions-repo.mjs），照 actions-repo.mjs:210-233 createValidatedAction 的纪律——pipeline 不直写表。
- G0（完整性/幂等）：action_emotions 无 chain_hash 问题（行键天然幂等，重复 upsert=更新）；标签批量导入必须带 provenance（来源=审计批次号），沿用 SHA256_RE 格式校验（ingestion-pipeline.mjs:34）。
- G1-G3 不重复校验链本体：emotion 行不引入新链，action_id 必须已 validated（外键+查询时 `JOIN motion_definitions WHERE status='validated'`，与 motion_definitions:411-413 状态机一致）。
- G4 所有权/资源冲突：emotion 标签不写参数，无冲突面；execution 权限检查仍由 Chain Validator 层负责。
- 拒绝留痕：坏标签行走 recordRejectedAction 同款留痕（ingestion-pipeline.mjs:8 纪律），日志进 motion_status_log 同风格的审计轨迹（可选，P3 再定）。

## 3. 语义 expression → 模型 Profile 映射机制

三级解析，执行期进行（Bridge 侧纯函数 `resolveExpression(expression, modelId)`）：

1. **绑定层**：motion_model_bindings.adapter_json（schema.mjs:455-462）查该 motion 在目标模型的 adapter 是否声明 expression 映射。
2. **注册表层**：w3-registry registry.json entries（capability-registry.mjs 实测结构：entries[].{id,kind,label,slot}），kind='expression' 的 entry.id/label 与语义 token 匹配（如 'smile' → 模型表情'兔牙'）。
3. **降级**：均未命中 → 该步跳过、链照常执行其余步（choreography.mjs:167 fallback 同纪律），回执标注 `expression_unresolved`，绝不发明参数。

Model Profile 载体不新增表：model_capabilities.capability_json（schema.mjs:446-453）+ capability_profiles（schema.mjs:282-289）承担；换模型=新 bindings 行+新 profile 版本，action_emotions 零改动。

## 4. Observer 事件源映射（P1 命门，落到具体字段）

状态源合成：summarizeSession(summary) + ageSummaryState + readEnvState。字段出处：session-events.mjs:490-527（state/substate/jobs/commands/approvals/pendingTool/lastTurnEnd/hasError）、env-state.mjs:123-153。

| WorkspaceStatus | 判定条件（优先级从高到低） | 字段证据 |
|---|---|---|
| waiting_input | substate='waiting-approval'（approvals.pendingCount>0）或 substate='waiting-answer'（pendingTool 命中 ASK_USER_RE，session-events.mjs:481） | 子态**只在 ageMs≤waitingHoldMs(600s) 内有效**（session-events.mjs:239-242），超期自然回落，不得拿旧值调度 |
| waiting_subagent | state∈{thinking,working} 且（jobs.runningCount>0 或 commands.runningCount>0）且无 waiting_input 条件 | job/registered 未 settle（session-events.mjs:396-406）、command/run 未 done（:422-427）、后台化工具标记（:14 头注 moved-to-background） |
| error | state='error'（turn/end error）或 hasError 且 ageMs≤errorHoldMs(600s) | session-events.mjs:364-370,245-247 |
| succeeded | lastTurnEnd.kind='completed' 且该 turn 尚未被调度过（dedup key 含 lastTurnEnd.time） | session-events.mjs:371-372 |
| running | pendingTool 非空（前台工具在途）且非 ask-user | session-events.mjs:316-321 |
| idle | 老化后 idle（idleAfterMs=120s）或无会话 | session-events.mjs:244-251 |

env-state 只作修饰不作主状态：conversation/work/away 影响「是否值得调度」（离席静默对齐 decideNotification workspace-agent.mjs:191-199），30s 过期按 unknown（env-state.mjs:19）。**waiting_subagent 与 waiting_input 判定互斥**：waiting_input 条件优先，杜绝代答。

revision/eventId：会话文件无单调事件版本号，采用 `revision = lastEventAt`（单调不减），`eventId = sessionId + ':' + lastEventAt + ':' + 判定状态`；Observer 缓存失效复用 mtime+size 双检（index.js:577-583 既有模式）。历史成功率（Matcher 权重 10%）：execution_history（schema.mjs:464-474）按 motion_id 聚合 completed/failed。

## 5. 检索加权与阈值（裁决书 §3 落表口径）

score = capability 0.35 + status 0.25 + emotion 0.20 + expression 0.10 + 历史成功率 0.10；每维归一到 [0,1]：
- capability：动作 capabilityId 命中 Capability Registry 断言=1，否则 0（fail-closed）。
- status：action_emotions/chain_tags 命中当前 WorkspaceStatus 对应标签的程度（精确=1，同族=0.5）。
- emotion/expression：approved 标签精确命中=1，VAD 近邻（P3 再引入）暂按 0/1。
- 历史成功率：completed/(completed+failed+timeout)，样本 <5 次按 0.5 中性值（不冒充置信度）。
阈值 ≥0.85 直接采用、0.65-0.85 查兼容、<0.65 未命中返回 `{status:'unmatched'}`（不偷偷调 Composer）。缓存=SQLite 结果缓存，指标落库（命中率/匹配分）。
