/**
 * 身体部位参数域清单（M1-g / G1）。
 *
 * **生成物，勿手改**：由 `node tools/gen-body-manifest.mjs` 从
 * `DeepSeek免费公皮/DeepSeek/大肥鱼.physics3.json` + `大肥鱼.cdi3.json` 生成。
 * 依据：docs/M1-G-PHYSICS-RIG-AUDIT.md §2.3（292 个物理输出的精确 id）与 §3（域映射/S1–S5）。
 *
 * 分层（G0 §1.3 事实 3、§4.1 两条接管路径）：
 *  - `ARM_*_PHYSICS`：物理叶子域的**输出**（可 own，post 覆盖；0 下游消费者）。
 *  - `ARM_*_POSE`：姿态层（**不是**物理输出，普通写即可，不需要也不能 own）。
 *  - `CROSS_DOMAIN`：既是姿态层又是物理 Source（本模型 Param42 → 尾巴 PhysicsSetting131）。
 *  - `SHARED_FORBIDDEN`：共享枢纽/共享开关，**禁止**按侧独占（S1/S2/S5）。
 *  - `ROOT_ONLY`：头/躯干的物理根输入（只能写根，不能 own 输出；S1/S2）。
 *
 * 源文件指纹：physics3=eb5f6cac515123a8 cdi3=24d1a66f530153b2（131 settings / 292 物理输出）。
 */

/** 右臂物理输出（settings 73/75/78/79/80）（15 个） */
export const ARM_RIGHT_PHYSICS: readonly string[] = [
  'RArm',
  'RForearm',
  'RHand',
  'RHand2',
  'RRibbonX1',
  'RRibbonX2',
  'RRibbonX3',
  'RRibbonX4',
  'RSleeveX1',
  'RSleeveX2',
  'RSleeveX3',
  'RSleeveY1',
  'RSleeveY2',
  'RSleeveY3',
  'RWrist',
];

/** 左臂物理输出（settings 72/74/76/77/81）（15 个） */
export const ARM_LEFT_PHYSICS: readonly string[] = [
  'LArm',
  'LForearm',
  'LHand',
  'LHand2',
  'LRibbonX1',
  'LRibbonX2',
  'LRibbonX3',
  'LRibbonX4',
  'LSleeveX1',
  'LSleeveX2',
  'LSleeveX3',
  'LSleeveY',
  'LSleeveY2',
  'LSleeveY3',
  'LWrist',
];

/** 双臂物理输出合集 = limb 可 own 白名单的全集（30 个） */
export const ARM_ALL_PHYSICS: readonly string[] = [
  'LArm',
  'LForearm',
  'LHand',
  'LHand2',
  'LRibbonX1',
  'LRibbonX2',
  'LRibbonX3',
  'LRibbonX4',
  'LSleeveX1',
  'LSleeveX2',
  'LSleeveX3',
  'LSleeveY',
  'LSleeveY2',
  'LSleeveY3',
  'LWrist',
  'RArm',
  'RForearm',
  'RHand',
  'RHand2',
  'RRibbonX1',
  'RRibbonX2',
  'RRibbonX3',
  'RRibbonX4',
  'RSleeveX1',
  'RSleeveX2',
  'RSleeveX3',
  'RSleeveY1',
  'RSleeveY2',
  'RSleeveY3',
  'RWrist',
];

/** 右臂姿态层（非物理输出，普通写）（5 个） */
export const ARM_RIGHT_POSE: readonly string[] = [
  'Param36',
  'Param39',
  'Param40',
  'Param41',
  'Param43',
];

/** 左臂姿态层（非物理输出，普通写）（4 个） */
export const ARM_LEFT_POSE: readonly string[] = [
  'Param59',
  'Param60',
  'Param61',
  'Param62',
];

/** 姿态层同时是物理 Source（跨域耦合）（1 个） */
export const CROSS_DOMAIN: readonly string[] = [
  'Param42',
];

/** 共享枢纽/开关，禁止按侧独占（11 个） */
export const SHARED_FORBIDDEN: readonly string[] = [
  'Movement1',
  'Movement2',
  'Movement3',
  'Param35',
  'ParamAngleX',
  'ParamAngleY',
  'ParamAngleZ',
  'ParamBodyAngleRX',
  'ParamBodyAngleX',
  'ParamBodyAngleY',
  'ParamBodyAngleZ',
];

/** 头/躯干物理根输入（只写根输入，不 own 输出）。 */
export const ROOT_ONLY: Readonly<{ head: readonly string[]; torso: readonly string[] }> = {
  head: [
    'AngleX',
    'AngleY',
    'AngleZ',
  ],
  torso: [
    'LeanInput',
    'PositionX',
    'PositionY',
    'PositionZ',
  ],
};

/** `ARM_ALL_PHYSICS` 的集合视图（LimbController.isOwnable 的唯一判据）。 */
export const MANIFEST_ALL_PHYSICS: ReadonlySet<string> = new Set(ARM_ALL_PHYSICS);
