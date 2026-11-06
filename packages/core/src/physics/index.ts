/**
 * PR-C 物理能力模块聚合导出（只新增，不改既有文件）。
 * 注意：本模块 G0-G2 只读分析 + 纯函数决策；G3 Runtime 接管另行审核，当前不提供任何写入口。
 */
export * from './types.ts';
export { buildPhysicsGraph } from './graph.ts';
export {
  analyzePhysicsCapability,
  buildCapabilityManifest,
  modelHashFromMoc3,
  isDecorationParameter,
  isSharedHub,
  leftRightMismatch,
  ARM_LEAF_CORE,
  MANIFEST_VERSION,
} from './analyzer.ts';
export { decideLimbAllocation, CapabilityManifestCache } from './allocation.ts';
