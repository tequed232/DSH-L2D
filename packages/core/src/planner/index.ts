/** PR-D 规划器聚合导出（只新增；正式集成依赖 PR-A 稳定契约，本模块不接 Runtime）。 */
export * from './types.ts';
export { analyzePair, analyzePlanConflicts, planVerdict, sequencingConstraints } from './conflict-resolver.ts';
export { buildMotionPlan, priorityFromIntensity, type PlannerCapabilityProvider } from './plan-builder.ts';
export { planToTimelineInstructions, assertNoDirectParamWrites, type TimelineInstruction } from './timeline-adapter.ts';
export { InMemoryActionsLib, queryActionAvailability, reportPlanOutcome, type ActionsLibQuery, type ActionRecord } from './actions-lib.ts';
