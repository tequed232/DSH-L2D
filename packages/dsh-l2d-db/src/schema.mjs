/**
 * dsh-l2d · 统一注册表 schema（迁移式，v1）
 *
 * 两个域：
 *  A. Bootstrap 域：skills / workspaces / toolchain_components / startup_checks / tasks
 *     —— 对应《Skill框架与工作区引导-Phase0审计与差距报告》D2/D3/D6/D8。
 *  B. 模型智能域：models / source_files / assets / nodes / edges / parameters /
 *     parameter_bindings / semantic_labels / motions / physics_groups /
 *     analysis_jobs / probe_runs / capability_profiles / validation_findings
 *     —— 对应 skills/dsh-l2d-model-intelligence SKILL.md Phase 6。
 *
 * 约定：
 *  - 一切写入走外键 + 约束；禁推理数据冒充事实（evidence_level 三级）。
 *  - 幂等：models 按 model_id，nodes 按 (model_id, node_key)，skills 按 name，
 *    toolchain_components 按 name —— 重复注册=更新，不产生重复行。
 *  - 迁移只追加不改写；schema_migrations 记录版本与耗时。
 */

export const SCHEMA_VERSION = 1;

/** v1 全量 DDL。单条 exec 执行，语句间以分号分隔。 */
export const MIGRATIONS = {
  1: `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    -- ========== A. Bootstrap 域 ==========

    -- Skill 注册表（状态机：discovered/valid/registered/loaded/degraded/invalid/missing）
    CREATE TABLE IF NOT EXISTS skills (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      version       TEXT NOT NULL,
      path          TEXT,
      content_hash  TEXT,
      frontmatter   TEXT,            -- frontmatter 原文（JSON）
      status        TEXT NOT NULL DEFAULT 'discovered'
                    CHECK (status IN ('discovered','valid','registered','loaded','degraded','invalid','missing')),
      workspace_role TEXT,           -- orchestrator / structure-inspector / behavior-engineer / null
      registered_at TEXT,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- 工作区注册表（role 唯一：orchestrator / model-inspector / behavior-engineer / live2d-agent）
    CREATE TABLE IF NOT EXISTS workspaces (
      role                 TEXT PRIMARY KEY,
      workspace_id         TEXT NOT NULL,
      session_id           TEXT,
      title                TEXT NOT NULL,
      directory            TEXT NOT NULL,
      system_prompt_version TEXT NOT NULL,
      skill_bindings       TEXT NOT NULL DEFAULT '[]',   -- JSON array of skill names
      tool_permissions     TEXT NOT NULL DEFAULT '{}',   -- JSON object
      status               TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','recovering','archived','invalid')),
      created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_verified_at     TEXT
    );

    -- 工具链注册表（模型智能 Skill Phase 0 的状态枚举）
    CREATE TABLE IF NOT EXISTS toolchain_components (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      kind          TEXT NOT NULL DEFAULT 'tool'
                    CHECK (kind IN ('tool','runtime','sdk','mcp-server','parser','service')),
      version       TEXT,
      source_url    TEXT,
      commit_sha    TEXT,
      install_path  TEXT,
      checksum      TEXT,
      provenance    TEXT,            -- 来源说明（repo/release/manual）
      status        TEXT NOT NULL DEFAULT 'missing'
                    CHECK (status IN ('present_verified','present_unverified','missing','incompatible','license_gated')),
      smoke_test    TEXT,            -- 最近一次 smoke test 结果（JSON）
      last_verified_at TEXT,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- 启动检查流水（Bootstrap Report 的持久层；gate 状态见 startup_gate 字段）
    CREATE TABLE IF NOT EXISTS startup_checks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT NOT NULL,
      component     TEXT NOT NULL,   -- 'skill:<name>' / 'workspace:<role>' / 'toolchain:<name>' / 'runtime:<name>'
      phase         TEXT NOT NULL DEFAULT 'p1'
                    CHECK (phase IN ('p0','p1','p2','gate')),
      status        TEXT NOT NULL
                    CHECK (status IN ('pass','warn','fail','skipped')),
      gate          TEXT
                    CHECK (gate IN ('READY','DEGRADED','BLOCKED','RECOVERING','NEEDS_AUTHORIZATION')),
      detail        TEXT,            -- JSON
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_startup_checks_run ON startup_checks(run_id, component);

    -- 跨工作区任务协议（任务书 §六）
    CREATE TABLE IF NOT EXISTS tasks (
      task_id            TEXT PRIMARY KEY,
      parent_task_id     TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
      assigned_workspace TEXT,
      assigned_skill     TEXT,
      model_id           TEXT,
      analysis_job_id    TEXT,
      title              TEXT NOT NULL DEFAULT '',
      input_artifacts    TEXT NOT NULL DEFAULT '[]',  -- JSON
      expected_outputs   TEXT NOT NULL DEFAULT '[]',  -- JSON
      status             TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','assigned','running','done','failed','cancelled')),
      priority           TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('FORCE','NORMAL','IDLE')),
      deadline           TEXT,
      evidence           TEXT,         -- JSON：验收证据指针
      error              TEXT,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority);

    -- ========== B. 模型智能域 ==========

    CREATE TABLE IF NOT EXISTS models (
      model_id      TEXT PRIMARY KEY,          -- 调用方生成的稳定 ID
      title         TEXT,
      source_path   TEXT NOT NULL,
      package_hash  TEXT NOT NULL,             -- 原始包 SHA-256
      moc3_version  TEXT,
      status        TEXT NOT NULL DEFAULT 'imported'
                    CHECK (status IN ('imported','analyzed','runtime_verified')),
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_models_hash ON models(package_hash);

    CREATE TABLE IF NOT EXISTS source_files (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      sha256        TEXT,
      size_bytes    INTEGER,
      format        TEXT,
      UNIQUE (model_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_source_files_model ON source_files(model_id);

    CREATE TABLE IF NOT EXISTS assets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      kind          TEXT NOT NULL,             -- texture/motion/physics/expression/pose/userdata/audio/other
      sha256        TEXT,
      missing       INTEGER NOT NULL DEFAULT 0,-- 悬空引用
      UNIQUE (model_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_assets_model ON assets(model_id, kind);

    -- 结构图节点（不把 deformer 层级拍平成假骨骼；evidence 三级）
    CREATE TABLE IF NOT EXISTS nodes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      node_key      TEXT NOT NULL,             -- 模型内稳定键（ID 或路径）
      node_type     TEXT NOT NULL CHECK (node_type IN
                    ('Model','Parameter','Part','Deformer','ArtMesh','Texture','Motion','Expression','PhysicsGroup','Mask')),
      display_name  TEXT,
      evidence_level TEXT NOT NULL DEFAULT 'parser_derived'
                     CHECK (evidence_level IN ('source_exact','parser_derived','inferred')),
      confidence    REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      source_file_id INTEGER REFERENCES source_files(id) ON DELETE SET NULL,
      source_pointer TEXT,
      parser_name   TEXT,
      parser_version TEXT,
      UNIQUE (model_id, node_key)
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_model_type ON nodes(model_id, node_type);

    CREATE TABLE IF NOT EXISTS edges (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      src_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      dst_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      edge_type     TEXT NOT NULL CHECK (edge_type IN
                    ('contains','deforms','drives','uses_texture','masks','references','belongs_to_part')),
      evidence_level TEXT NOT NULL DEFAULT 'parser_derived'
                     CHECK (evidence_level IN ('source_exact','parser_derived','inferred')),
      confidence    REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      UNIQUE (model_id, edge_type, src_id, dst_id)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_model_type ON edges(model_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id);

    CREATE TABLE IF NOT EXISTS parameters (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      param_id      TEXT NOT NULL,
      name          TEXT,
      min_value     REAL,
      max_value     REAL,
      default_value REAL,
      node_id       INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
      UNIQUE (model_id, param_id)
    );
    CREATE INDEX IF NOT EXISTS idx_parameters_model ON parameters(model_id);

    CREATE TABLE IF NOT EXISTS parameter_bindings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id        TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      parameter_id    INTEGER NOT NULL REFERENCES parameters(id) ON DELETE CASCADE,
      target_node_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      binding_kind    TEXT NOT NULL,           -- keyform/deform/draw_order/...
      keyform_count   INTEGER,
      evidence_level  TEXT NOT NULL DEFAULT 'parser_derived'
                      CHECK (evidence_level IN ('source_exact','parser_derived','inferred')),
      UNIQUE (parameter_id, target_node_id, binding_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_bindings_model ON parameter_bindings(model_id);

    -- 语义标签：推断数据独立存放，绝不直写运行时参数
    CREATE TABLE IF NOT EXISTS semantic_labels (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      node_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      label         TEXT NOT NULL,
      confidence    REAL CHECK (confidence >= 0 AND confidence <= 1),
      evidence      TEXT,                      -- JSON
      review_state  TEXT NOT NULL DEFAULT 'needs_review'
                    CHECK (review_state IN ('needs_review','approved','rejected')),
      UNIQUE (node_id, label)
    );

    CREATE TABLE IF NOT EXISTS motions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      source_file_id INTEGER REFERENCES source_files(id) ON DELETE SET NULL,
      duration_ms   REAL,
      loop          INTEGER NOT NULL DEFAULT 0,
      meta          TEXT,                      -- JSON
      UNIQUE (model_id, name)
    );

    CREATE TABLE IF NOT EXISTS physics_groups (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      settings      TEXT,                      -- JSON
      UNIQUE (model_id, name)
    );

    CREATE TABLE IF NOT EXISTS analysis_jobs (
      id            TEXT PRIMARY KEY,          -- analysis_job_id
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','done','failed')),
      started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      finished_at   TEXT,
      tool_versions TEXT,                      -- JSON：parser/schema 版本
      notes         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_model ON analysis_jobs(model_id, status);

    CREATE TABLE IF NOT EXISTS probe_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
      parameter_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      baseline        TEXT NOT NULL,           -- JSON：基线状态
      input_value     REAL NOT NULL,
      result          TEXT,                    -- JSON：diff + 观测
      restored        INTEGER NOT NULL DEFAULT 0,  -- 基线是否已恢复
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_probe_runs_job ON probe_runs(analysis_job_id);

    CREATE TABLE IF NOT EXISTS capability_profiles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      version       TEXT NOT NULL,
      profile       TEXT NOT NULL,             -- JSON：能力画像
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (model_id, version)
    );

    CREATE TABLE IF NOT EXISTS validation_findings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id      TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
      severity      TEXT NOT NULL CHECK (severity IN ('info','warn','error')),
      code          TEXT NOT NULL,
      message       TEXT NOT NULL,
      evidence      TEXT                       -- JSON
    );
    CREATE INDEX IF NOT EXISTS idx_findings_model ON validation_findings(model_id, severity);
  `,
};
