/**
 * [M1-b] 物理输出让位登记表（PhysicsGate 的 fw 侧数据面）。
 *
 * 职责：登记「本帧不接收物理输出写入」的参数 id。集合内的 id 在
 * `CubismPhysics.evaluate` / `interpolate`（cubismphysics.ts）里被跳过：
 *   - evaluate：跳过 `_parameterCaches` 回写 → 同帧 chained 消费者（裙摆 4 + 腿链 1 + 3 个设置）
 *     读到的是 Agent pre 写入的值，次级链随动（Embodied-Behavior 拍板 1 / 冲突 C9）；
 *   - interpolate：跳过 parameterValues 落写 → Agent 的 pre 值不被物理覆盖。
 * 振子内部状态（_currentRigOutputs/_previousRigOutputs）照常推进，release 后下一帧
 * 物理从保温状态平滑接管（R8：释放回物理，无恢复逻辑）。
 *
 * 为什么是模块单例：CubismPhysics 实例深藏在 LAppModel → CubismUserModel 内部，
 * 渲染层（index.ts / motion-adapter.ts）拿不到稳定引用；登记表必须零依赖、
 * 可被 node 单测直连（--experimental-strip-types），因此不放进 cubismphysics.ts 本体。
 *
 * 帧时序（Embodied-Behavior §1）：pre 钩子内 injector.apply('pre') 落 Agent 值 →
 * PhysicsGate.pre 登记 → Physics600 evaluate/interpolate 按表让位 → post 钩子。
 * flag 关（embodied.m1=false）时 PhysicsGate 不调用本表，集合恒空 = 现行为。
 */

/** 本帧让位的物理输出 id 集合（PhysicsGate.pre 每帧整体替换）。 */
export const physicsYield: {
  ids: Set<string>;
  /** 整体替换为本帧集合（空数组 = 全部恢复物理写入）。 */
  replace(ids: Iterable<string>): void;
  /** 清空（destroy / 回滚路径用）。 */
  clear(): void;
} = {
  ids: new Set<string>(),
  replace(ids: Iterable<string>): void {
    this.ids = new Set(ids);
  },
  clear(): void {
    this.ids = new Set<string>();
  },
};
