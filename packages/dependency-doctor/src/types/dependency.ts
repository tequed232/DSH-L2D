/**
 * Dependency Doctor 类型契约（PR-E）。
 *
 * 设计铁律：诊断与安装严格分离——
 *   scan()       只检测，不修改环境；
 *   planRepair() 只生成计划，不执行；
 *   真正的安装必须携带显式用户授权（RepairAuthorization），且仅限 registry 白名单操作。
 */

export type DependencyCategory = 'sdk' | 'runtime' | 'model' | 'project' | 'system';

export type DependencyStatus =
  | 'installed' // 检测到且满足要求
  | 'missing'   // 未检测到
  | 'incompatible' // 检测到但版本/内容不满足
  | 'unverified'   // 无法在本环境确认（如实标注，不臆测）
  | 'blocked';     // 被许可/授权条件挡住（如 SDK 授权未确认）

export interface DependencyCheck {
  /** 引用 registry/dependencies.json 的条目 id */
  id: string;
  name: string;
  category: DependencyCategory;
  requiredVersion: string;
  required: boolean;
  officialSource?: string;
  /** 许可确认前置（SDK 类）：未确认时不自动安装，只给引导 */
  licenseRequired?: boolean;
  /** 执行检测。只读，禁止副作用。 */
  check(ctx: ScanContext): Promise<DependencyFinding> | DependencyFinding;
}

export interface ScanContext {
  /** 仓库/工作区根目录（绝对路径） */
  rootDir: string;
  /** 模型目录（绝对路径；用户提供或自动探测） */
  modelDir?: string;
  /** 已检测报告缓存（适配器间引用，如 SDK 报告） */
  reports?: Map<string, DependencyReport>;
}

export interface DependencyFinding {
  status: DependencyStatus;
  detectedVersion?: string;
  /** 检测路径 / 证据位置 */
  detectedPath?: string;
  /** 人读说明（缺什么、为什么） */
  detail?: string;
  /** model 类专用：缺失的具体引用文件（相对 model3.json 的路径） */
  missingFiles?: string[];
}

export interface DependencyReport {
  id: string;
  name: string;
  category: DependencyCategory;
  requiredVersion: string;
  detectedVersion?: string;
  detectedPath?: string;
  status: DependencyStatus;
  required: boolean;
  officialSource?: string;
  licenseRequired?: boolean;
  detail?: string;
  missingFiles?: string[];
  /** 该项是否支持程序化修复（false = 只能人工处理） */
  repairSupported: boolean;
  checkedAt: string;
}

export type RepairKind = 'npm-install' | 'download' | 'manual';

export interface InstallStep {
  id: string;
  kind: RepairKind;
  /** 对应的 DependencyReport.id */
  target: string;
  description: string;
  /** npm-install：包名@版本（仅 registry 白名单内） */
  packageSpec?: string;
  /** download：官方下载地址（仅 registry 登记来源） */
  downloadUrl?: string;
  /** 下载目标路径（相对 rootDir） */
  targetPath?: string;
  /** 预期字节数（下载校验用，未知为空） */
  sizeBytes?: number;
  /** 预期 SHA-256（hex）；缺失时 integrity-verifier 拒绝放行 */
  sha256?: string;
  /** 安装前必须展示给用户的内容已齐备 */
  requiresAuthorization: true;
  /** manual：给用户的操作指引 */
  instructions?: string;
}

export interface InstallPlan {
  createdAt: string;
  steps: InstallStep[];
  /** 无法程序化修复、需要用户处理的项 */
  manual: Array<{ id: string; name: string; officialSource?: string; reason: string }>;
}

/**
 * 用户授权凭据。核心库不自带 UI；授权由调用方（宿主/Setup Wizard）收集后显式传入。
 * 缺失或 granted !== true 时一切安装操作直接拒绝（fail-closed）。
 */
export interface RepairAuthorization {
  granted: true;
  /** 授权来源标识（如 'setup-wizard'），写入诊断日志 */
  grantedBy: string;
  /** 用户确认过的 step id 清单；不在清单内的 step 不执行 */
  stepIds: string[];
  grantedAt: string;
}

export interface RepairResult {
  stepId: string;
  ok: boolean;
  /** 执行后的验证结论 */
  verified?: boolean;
  error?: string;
}

export interface RuntimeReadiness {
  ready: boolean;
  /** 阻止 Runtime 初始化的原因清单（required 项未满足） */
  blocked: Array<{ id: string; name: string; status: DependencyStatus; reason: string }>;
}
