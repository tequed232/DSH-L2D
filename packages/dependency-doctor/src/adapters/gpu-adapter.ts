/**
 * GPU / 图形 API 适配器（system 类）。
 *
 * Node 环境没有 WebGL 上下文，无法可靠探测 GPU 兼容性。
 * 硬约束：检测不了就 unverified，不臆测、不伪造。浏览器端检测
 * 由宿主（Setup Wizard）在渲染环境接入后补充。
 */
import type { DependencyFinding, ScanContext } from '../types/dependency.ts';

export function checkGpu(ctx: ScanContext): DependencyFinding {
  return {
    status: 'unverified',
    detail: 'GPU/WebGL 兼容性需在浏览器渲染环境中检测；Node 侧不可判定（如实标注，不臆测）',
  };
}
