/**
 * dsh-l2d · 统一注册表 schema（迁移式，v2）
 *
 * 两个域：
 *  A. Bootstrap 域：skills / workspaces / toolchain_components / startup_checks / tasks
 *     —— 对应《Skill框架与工作区引导-Phase0审计与差距报告》D2/D3/D6/D8。
 *  B. 模型智能域：models / source_files / assets / nodes / edges / parameters /
 *     parameter_bindings / semantic_labels / motions / physics_groups /
 *     analysis_jobs / probe_runs / capability_profiles / validation_findings
 *     —— 对应 skills/dsh-l2d-model-intelligence SKILL.md Phase 6。
 *  C. 图库语义域（v2）：gallery_items / gallery_labels / prompt_templates
 *     —— 外部参考图库（角色设定表/同人图/截图/动作参考）的登记、语义标签与
 *        提示词模板注册。标签经 linked_node_id 与模型结构节点桥接。
 *  D. 动作知识域（v3）：motion_assets / motion_analysis / motion_definitions /
 *     action_chains / action_steps / motion_sources / model_capabilities /
 *     motion_model_bindings / execution_history / learning_jobs
 *     —— 落地 docs/architecture/MOTION-DATA-SCHEMA.md §2/§3（修正版）。
 *     动作链与模型参数解耦：语义链经 motion_model_bindings 适配到具体模型。
 *
 * 约定：
 *  - 一切写入走外键 + 约束；禁推理数据冒充事实（evidence_level 三级）。
 *  - 幂等：models 按 model_id，nodes 按 (model_id, node_key)，skills 按 name，
 *    toolchain_components 按 name，gallery_items 按 file_name，
 *    prompt_templates 按 template_id —— 重复注册=更新，不产生重复行。
 *  - 迁移只追加不改写；schema_migrations 记录版本与耗时。
 */

export const SCHEMA_VERSION = 4;

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

  /**
   * v2：图库语义域（2026-11-04，图库包到达后建）。
   * 设计要点：
   *  - 图像侧标签与模型侧标签分表（v1 semantic_labels 绑 node_id，不动）；
   *  - gallery_labels.linked_node_id 是图↔模型结构的可选桥（节点删除置 NULL，不级联毁图）；
   *  - real_format 以魔数嗅探为准，与扩展名不符属正常事实（如 B站 heic 存成 .png）；
   *  - prompt_templates 注册提示词资产本体，模板进化按 (template_id, version) 追溯。
   */
  2: `
    CREATE TABLE IF NOT EXISTS gallery_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name     TEXT NOT NULL UNIQUE,
      real_format   TEXT NOT NULL,             -- 魔数嗅探：png/jpeg/gif/heic/webp/avif/unknown
      ext           TEXT NOT NULL,             -- 扩展名原样
      width         INTEGER,
      height        INTEGER,
      size_bytes    INTEGER,
      sha256        TEXT,
      source_class  TEXT NOT NULL DEFAULT 'other'
                    CHECK (source_class IN
                    ('character_sheet','fan_art','screenshot','gif_reference','photo','poster','other')),
      review_state  TEXT NOT NULL DEFAULT 'pending'
                    CHECK (review_state IN ('pending','labeled','approved','rejected')),
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_items_class ON gallery_items(source_class, review_state);
    CREATE INDEX IF NOT EXISTS idx_gallery_items_sha ON gallery_items(sha256);

    CREATE TABLE IF NOT EXISTS gallery_labels (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id         INTEGER NOT NULL REFERENCES gallery_items(id) ON DELETE CASCADE,
      field           TEXT NOT NULL
                      CHECK (field IN
                      ('part','expression','pose','outfit','style','scene','motion_cue','color','other')),
      value           TEXT NOT NULL,
      confidence      REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      evidence_level  TEXT NOT NULL DEFAULT 'inferred'
                      CHECK (evidence_level IN ('source_exact','parser_derived','inferred')),
      evidence        TEXT,                    -- JSON：prompt 模板、模型版本、原文摘录等
      review_state    TEXT NOT NULL DEFAULT 'needs_review'
                      CHECK (review_state IN ('needs_review','approved','rejected')),
      linked_node_id  INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (item_id, field, value)
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_labels_item ON gallery_labels(item_id, field);
    CREATE INDEX IF NOT EXISTS idx_gallery_labels_node ON gallery_labels(linked_node_id);

    CREATE TABLE IF NOT EXISTS prompt_templates (
      template_id   TEXT NOT NULL,
      version       TEXT NOT NULL,
      target_class  TEXT NOT NULL
                    CHECK (target_class IN
                    ('character_sheet','fan_art','screenshot','gif_reference','photo','poster','other')),
      body          TEXT NOT NULL,             -- 提示词全文
      schema_ref    TEXT,                      -- 输出应遵守的 JSON Schema（路径/URI）
      status        TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','deprecated')),
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (template_id)
    );
  `,

  /**
   * v3：动作知识域（2026-11-04，落地 MOTION-DATA-SCHEMA §2/§3 修正版）。
   * 设计要点：
   *  - 动作知识独立于模型结构域：motion_definitions 的 actions_chain 是模型无关语义链，
   *    经 motion_model_bindings.adapter_json + Model Adapter 映射到具体模型参数；
   *  - 仅 validated 状态的动作可进执行流程（CHECK 枚举 + 消费方纪律）；
   *  - execution_history 修正了任务书 §2 的笔误（motion_id + model_id 双列）；
   *  - schema_migrations 在本库 v1 已存在，不重复建。
   * 偏差记录：Phase 1 文档写"单一 actions-lib.sqlite"，本实现并入统一注册表
   * （bootstrap-state.sqlite），理由：同一 node:sqlite 内核、共享迁移机制、避免双库事务。
   * 若未来需要物理拆分，按表名前缀迁出即可（表名未加域前缀即为此保留）。
   */
  3: `
    CREATE TABLE IF NOT EXISTS motion_assets (
      id            TEXT PRIMARY KEY,
      source_type   TEXT NOT NULL CHECK (source_type IN ('image','archive','video','gif')),
      original_path TEXT NOT NULL,
      archive_path  TEXT,
      content_hash  TEXT NOT NULL,
      imported_at   TEXT NOT NULL,
      metadata_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_motion_assets_hash ON motion_assets(source_type, content_hash);

    CREATE TABLE IF NOT EXISTS motion_analysis (
      id            TEXT PRIMARY KEY,
      asset_id      TEXT NOT NULL REFERENCES motion_assets(id) ON DELETE CASCADE,
      model_name    TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      confidence    REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_motion_analysis_asset ON motion_analysis(asset_id);

    CREATE TABLE IF NOT EXISTS motion_definitions (
      id            TEXT PRIMARY KEY,
      semantic_key  TEXT NOT NULL,
      description   TEXT NOT NULL,
      emotion       TEXT,
      expression    TEXT,
      gaze          TEXT,
      body_language TEXT,
      version       INTEGER NOT NULL DEFAULT 1,
      status        TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','analyzing','planned','validated','rejected','deprecated')),
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_motion_def_semantic ON motion_definitions(semantic_key);
    CREATE INDEX IF NOT EXISTS idx_motion_def_status ON motion_definitions(status);

    CREATE TABLE IF NOT EXISTS action_chains (
      id               TEXT PRIMARY KEY,
      motion_id        TEXT NOT NULL REFERENCES motion_definitions(id) ON DELETE CASCADE,
      chain_json       TEXT NOT NULL,
      schema_version   TEXT NOT NULL,
      validation_report TEXT,
      created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chains_motion ON action_chains(motion_id);

    CREATE TABLE IF NOT EXISTS action_steps (
      id          TEXT PRIMARY KEY,
      chain_id    TEXT NOT NULL REFERENCES action_chains(id) ON DELETE CASCADE,
      step_index  INTEGER NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('expression','motion','pose','look','keyframes')),
      params_json TEXT NOT NULL,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_steps_chain ON action_steps(chain_id, step_index);

    CREATE TABLE IF NOT EXISTS motion_sources (
      motion_id  TEXT NOT NULL REFERENCES motion_definitions(id) ON DELETE CASCADE,
      asset_id   TEXT NOT NULL REFERENCES motion_assets(id) ON DELETE CASCADE,
      analysis_id TEXT REFERENCES motion_analysis(id) ON DELETE SET NULL,
      PRIMARY KEY (motion_id, asset_id)
    );

    CREATE TABLE IF NOT EXISTS model_capabilities (
      id               TEXT PRIMARY KEY,
      model_id         TEXT NOT NULL,
      capability_json  TEXT NOT NULL,
      source_revision  TEXT NOT NULL,
      verified_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_caps_model ON model_capabilities(model_id);

    CREATE TABLE IF NOT EXISTS motion_model_bindings (
      motion_id   TEXT NOT NULL REFERENCES motion_definitions(id) ON DELETE CASCADE,
      model_id    TEXT NOT NULL,
      adapter_json TEXT,
      compatible  INTEGER NOT NULL DEFAULT 1,
      verified_at TEXT NOT NULL,
      PRIMARY KEY (motion_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS execution_history (
      id          TEXT PRIMARY KEY,
      motion_id   TEXT NOT NULL REFERENCES motion_definitions(id) ON DELETE CASCADE,
      model_id    TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('completed','interrupted','rejected','failed','timeout')),
      request_json TEXT,
      result_json TEXT,
      started_at  TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exec_motion ON execution_history(motion_id);

    CREATE TABLE IF NOT EXISTS learning_jobs (
      id                  TEXT PRIMARY KEY,
      source_id           TEXT NOT NULL,
      model_capability_id TEXT NOT NULL,
      state               TEXT NOT NULL DEFAULT 'uploaded'
                          CHECK (state IN ('uploaded','extracted','analyzed','planned','validated','persisted','failed')),
      asset_paths_json    TEXT,
      current_step        TEXT,
      error_json          TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_jobs_state ON learning_jobs(state);
  `,

  /**
   * v4：Phase 2 Foundation 最小缺项迁移（2026-11-04，依
   * docs/architecture/PHASE-2-FOUNDATION-GAP-AND-EXECUTION-PLAN.md P0-A/P0-B）。
   *  - action_chains 补 json_address / content_sha256 / chain_hash 三列：
   *    chain_hash 为语义链规范化内容的 SHA-256（幂等判定 R9），
   *    content_sha256 为快照文件内容哈希（R6 回读核对），json_address 为不可变快照路径（R2/R3）。
   *  - tasks（bootstrap 域既有表，复用不重建）补契约列：task_type/trace_id/
   *    attempt/max_attempts/input_payload/output_payload（P0-B 对齐任务书 §六）。
   *  - motion_status_log：状态转换只追加审计（拒绝留痕/转换可追溯）。
   * 均为加列/新表，不改既有列，可重复执行由 schema_migrations 门禁。
   */
  4: `
    ALTER TABLE action_chains ADD COLUMN json_address TEXT;
    ALTER TABLE action_chains ADD COLUMN content_sha256 TEXT;
    ALTER TABLE action_chains ADD COLUMN chain_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_action_chains_hash ON action_chains(chain_hash);
    ALTER TABLE action_steps ADD COLUMN admission TEXT;
    ALTER TABLE action_steps ADD COLUMN pairing_json TEXT;

    ALTER TABLE tasks ADD COLUMN task_type TEXT;
    ALTER TABLE tasks ADD COLUMN trace_id TEXT;
    ALTER TABLE tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
    ALTER TABLE tasks ADD COLUMN input_payload TEXT;
    ALTER TABLE tasks ADD COLUMN output_payload TEXT;
    CREATE INDEX IF NOT EXISTS idx_tasks_trace ON tasks(trace_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type, status);

    CREATE TABLE IF NOT EXISTS motion_status_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      motion_id   TEXT NOT NULL,
      from_status TEXT,
      to_status   TEXT NOT NULL,
      actor       TEXT,
      reason      TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_motion_status_log_motion ON motion_status_log(motion_id);
  `,
};
