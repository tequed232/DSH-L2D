# Phase 1 — MOTION-DATA-SCHEMA.md

> 配套：`docs/DSH-L2D-全量架构替换任务书.md`（§2/§3）、`docs/PHASE0-REPOSITORY-AUDIT.md`
> 状态：待用户审阅。

---

## 1. 设计原则

1. **动作知识与原始素材、模型能力、执行历史分开管理**（任务书 §2）。
2. **统一数据源**：单一 `actions-lib.sqlite`，开启 WAL、外键、事务、版本迁移。
3. **可追溯**：每条动作必须有素材来源、分析记录、动作链版本、验证报告与可追溯关系（任务书 §2 硬性要求）。
4. **动作链不与单一模型参数 ID 强绑定**：须经 Model Adapter 映射；模型适配关系独立成表（`motion_model_bindings`）。
5. **修正任务书 §2 SQL 笔误**：`execution_history` 原示例重复了 `motion_id` 列，本文件已更正为 `motion_id` + `model_id`。

---

## 2. 核心表（修正版）

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE motion_assets (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,            -- image | archive | video | gif
    original_path TEXT NOT NULL,
    archive_path TEXT,
    content_hash TEXT NOT NULL,           -- 重复检测
    imported_at TEXT NOT NULL,
    metadata_json TEXT                    -- 时长/帧数/阶段信息等
);

CREATE TABLE motion_analysis (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    analysis_json TEXT NOT NULL,          -- Motion Description（结构化）
    confidence REAL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(asset_id) REFERENCES motion_assets(id)
);

CREATE TABLE motion_definitions (
    id TEXT PRIMARY KEY,
    semantic_key TEXT NOT NULL,           -- 语义动作键
    description TEXT NOT NULL,
    emotion TEXT, expression TEXT, gaze TEXT, body_language TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,                 -- draft|analyzing|planned|validated|rejected|deprecated
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE action_chains (
    id TEXT PRIMARY KEY,
    motion_id TEXT NOT NULL,
    chain_json TEXT NOT NULL,             -- 与模型无关的语义动作链
    schema_version TEXT NOT NULL,
    validation_report TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(motion_id) REFERENCES motion_definitions(id)
);

CREATE TABLE motion_sources (
    motion_id TEXT NOT NULL, asset_id TEXT NOT NULL, analysis_id TEXT,
    PRIMARY KEY(motion_id, asset_id),
    FOREIGN KEY(motion_id) REFERENCES motion_definitions(id),
    FOREIGN KEY(asset_id) REFERENCES motion_assets(id),
    FOREIGN KEY(analysis_id) REFERENCES motion_analysis(id)
);

CREATE TABLE model_capabilities (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    capability_json TEXT NOT NULL,        -- 来自 Capability Registry
    source_revision TEXT NOT NULL,        -- registry.json sourceCommit
    verified_at TEXT NOT NULL
);

CREATE TABLE execution_history (
    id TEXT PRIMARY KEY,
    motion_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    status TEXT NOT NULL,                 -- completed|interrupted|rejected|failed|timeout
    request_json TEXT,
    result_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    FOREIGN KEY(motion_id) REFERENCES motion_definitions(id)
);

CREATE INDEX idx_motion_semantic ON motion_definitions(semantic_key);
CREATE INDEX idx_motion_status   ON motion_definitions(status);
CREATE INDEX idx_execution_motion ON execution_history(motion_id);
```

---

## 3. 建议新增表（任务书 §2）

```sql
-- 学习任务队列（可恢复状态机）
CREATE TABLE learning_jobs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    model_capability_id TEXT NOT NULL,
    state TEXT NOT NULL,                  -- uploaded|extracted|analyzed|planned|validated|persisted|failed
    asset_paths_json TEXT,
    current_step TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- 动作链步骤（数据驱动，替代旧 phase 模板）
CREATE TABLE action_steps (
    id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    kind TEXT NOT NULL,                   -- expression|motion|pose|look|keyframes
    params_json TEXT NOT NULL,
    duration_ms INTEGER,
    FOREIGN KEY(chain_id) REFERENCES action_chains(id)
);

-- 动作↔模型适配关系（替代旧的静态 MODEL_MOTION_GROUPS）
CREATE TABLE motion_model_bindings (
    motion_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    adapter_json TEXT,                    -- Model Adapter 映射结果
    compatible INTEGER NOT NULL DEFAULT 1,
    verified_at TEXT NOT NULL,
    PRIMARY KEY(motion_id, model_id),
    FOREIGN KEY(motion_id) REFERENCES motion_definitions(id)
);

-- 数据库版本迁移记录
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    note TEXT
);
```

---

## 4. Motion 数据标准（单条动作字段，任务书 §3）

每条 `motion_definitions` 记录须含：
`motion_id / semantic_key / description / emotion / facial_expression / gaze / body_language / source_asset / analysis_report / actions_chain / json_address / model_compatibility / capability_revision / schema_version / confidence / validation_report / status / created_at / updated_at`。

- `status` 至少：`draft / analyzing / planned / validated / rejected / deprecated`。
- 仅 `validated` 可进入正常执行流程。
- `actions_chain` 为**模型无关语义链**；经 `motion_model_bindings.adapter_json` + Model Adapter 映射到具体模型参数。

---

## 5. 与现有持久化的边界

| 数据 | 落点 | 说明 |
| --- | --- | --- |
| 动作知识 / 动作链 / 分析 / 执行历史 | `actions-lib.sqlite` | **新建**，统一数据源 |
| 插件设置 | `l2d-settings.json`（现有 JSON） | 不迁移，保持独立 |
| 人设（L1 动作知识） | `l2d-persona.json`（现有 JSON） | 不迁移，保持独立 |
| 环境交互态 / 反向桥事件 | `l2d-env-state.json` / `l2d-reverse-state.json` | 不迁移 |
| 能力画像 | `registry.json` / `profile.*.json` → `model_capabilities` 可同步镜像 | 运行时加载源 |

> 新建 SQLite 不冲突现有 JSON 持久化；但须明确"动作知识"只走 SQLite，避免双写漂移。

---

## 6. 迁移风险呼应（见 PHASE0 §6）

- **R1/R2**：`model_capabilities` 加载失败须 fail-closed 回退到冻结基线（旧 `MODEL_EXPRESSIONS`/`MODEL_MOTION_GROUPS` 作为兜底常量保留）。
- **R4**：`PAIRED_CLOSES`（开→关配对）须落表或保留派生逻辑，避免 `action_steps` 失配。
- **R6**：`excluded`/`unregisteredAssets` 在运行时须 fail-closed 消费（未登记通道不得执行）。
