export { openDb, migrate, withTransaction, resolveDbPath, defaultDbPath, SCHEMA_VERSION } from './db.mjs';
export { MIGRATIONS } from './schema.mjs';
export {
  SKILL_STATUSES, upsertSkill,
  WORKSPACE_ROLES, upsertWorkspace,
  TOOLCHAIN_STATUSES, upsertToolchainComponent, toolchainSnapshot,
  recordStartupCheck, startupReport,
  TASK_STATUSES, createTask, updateTaskStatus, getTask,
  upsertModel, upsertSourceFile, upsertNode, upsertEdge, upsertParameter,
  createAnalysisJob, finishAnalysisJob, saveCapabilityProfile, addValidationFinding,
} from './repo.mjs';

// ---- MCP Bridge（PR-A：工作区注册表；PR-C：动作持久化）----
export {
  BRIDGE_SESSION_KEYS, upsertBridgeWorkspace, findBridgeWorkspace, findBridgeWorkspaceByWorkspaceId,
  updateBridgeWorkspaceSession,
} from './bridge-repo.mjs';
export {
  insertRequest as insertBridgeAction, markRunning as markBridgeActionRunning,
  markTerminal as markBridgeActionTerminal, findById as findBridgeActionById,
  findUnfinished as findUnfinishedBridgeActions, markInterruptedAll as markInterruptedAllBridgeActions,
  BRIDGE_ACTION_TERMINAL_STATES,
} from './bridge-actions-repo.mjs';

// ---- Phase 2 Foundation（P0-A~P0-D）----
export {
  MOTION_TRANSITIONS, SEMANTIC_KEY_RE, canonicalChainHash,
  createActionsRepository, resolveActionModelHash,
} from './actions-repo.mjs';
export {
  WORKSPACE_IDS, CONTRACT_STATUSES, DB_STATUS_BY_CONTRACT, contractStatusOfDbStatus,
  OPERATION_SCHEMAS, validateAgainstSchema, createTaskContract,
} from './task-contract.mjs';
export {
  defaultRegistryPath, validateRegistryDocument, loadCapabilityRegistry,
} from './capability-registry.mjs';
export {
  validateAdapterShape, registeredParamIds,
  bindMotionToModel, resolveMotionParams, diffModelParameterSets,
} from './model-adapter.mjs';
export { createIngestionPipeline } from './ingestion-pipeline.mjs';

// ---- OACA-2 动作注册表（schema v12）----
export {
  manifestIdOf, publishBundleToDb, getPublishedAction, listPublishedActions,
  getCurrentManifest, markStaleByCapability, supersedeManifest,
} from './action-manifest-repo.mjs';
