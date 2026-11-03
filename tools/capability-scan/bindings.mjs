/**
 * 语义通道 → 模型参数的**匹配规则表**（不是某个模型的参数清单）。
 *
 * 设计原则：
 *   1. 这里只写「什么算作头部偏航」这类**语义判据**，具体参数 id 一律由扫描器从模型里解析；
 *      换模型不需要改这个文件，只改模型资源。
 *   2. 匹配不到 → unsupported（带原因），**不许猜 supported**。
 *   3. 没有绑定规则的通道 → unknown（fail-closed），不许默认放行。
 *   4. 命中物理输出的参数必须标 requires-own：物理默认持有这些值，直写会被 physics 覆盖。
 *
 * 置信度不是拍脑袋的分数，而是按「写入路径是否确定」分级：
 *   direct-free 0.95 / direct-physics 0.8 / compose 0.6。
 */

/** @typedef {{ id: string, group?: string }} ParamInfo */

const DIRECT = (ids) => ({ mode: 'direct', ids });
const COMPOSE = (ids, reason) => ({ mode: 'compose', ids, reason });

/**
 * 每个通道的匹配规则。
 * - direct：单一参数承载该语义，命中即 supported。
 * - compose：没有单一参数，需要多个参数组合表达，命中即 approximate。
 * - 缺省（未列出的通道）：unknown。
 */
export const CHANNEL_BINDINGS = {
  'head.yaw': DIRECT([/^AngleX$/]),
  'head.pitch': DIRECT([/^AngleY$/]),
  'head.roll': DIRECT([/^AngleZ$/]),

  'torso.lean': DIRECT([/^LeanInput$/]),
  'torso.sway': DIRECT([/^ParamBodyAngleX$/]),
  'torso.contraction': COMPOSE(['ShoulderX', 'ShoulderZ'], '靠双肩内收近似「缩肩」，无独立躯干收缩参数'),

  'gaze.x': DIRECT([/^ParamEyeBallX$/]),
  'gaze.y': DIRECT([/^ParamEyeBallY$/]),

  'arm.left.raise': DIRECT([/^LArm$/]),
  'arm.left.extend': DIRECT([/^LForearm$/]),
  'arm.left.inward': COMPOSE(['LForearm', 'LWrist'], '靠前臂+腕部组合近似「手臂内收」，无独立内收轴'),
  'arm.right.raise': DIRECT([/^RArm$/]),
  'arm.right.extend': DIRECT([/^RForearm$/]),
  'arm.right.inward': COMPOSE(['RForearm', 'RWrist'], '同上（右侧）'),

  // 腿部：不做模式匹配到任何近似参数。绝大多数 Live2D 半身模型没有腿部骨骼，
  // 用臀部参数硬凑会得到「塌陷」而不是「并拢」，宁可口报不支持。
  'leg.left.inward': { mode: 'none', reason: '模型无腿部内收参数（半身模型常见）' },
  'leg.left.bend': { mode: 'none', reason: '模型无膝关节参数' },
  'leg.right.inward': { mode: 'none', reason: '模型无腿部内收参数（半身模型常见）' },
  'leg.right.bend': { mode: 'none', reason: '模型无膝关节参数' },

  'face.blink': DIRECT([/^ParamEyeLOpen$/, /^ParamEyeROpen$/]),
  'body.breathing': DIRECT([/^ParamBreath$/]),
};

const CLOSED_EYES = /^(ParamEyeLOpen|ParamEyeROpen)$/;

/**
 * @param {object} inventory
 * @param {ParamInfo[]} inventory.params        模型真实参数
 * @param {string[]} inventory.physicsOutputs   物理输出参数 id（物理持有，直写需 own）
 * @param {(id:string)=>string|null} [inventory.blinkOwner] 引擎接管的眨眼参数（可选）
 * @returns {{ controls: any[], unresolved: string[] }}
 */
export function resolveControls(inventory) {
  const params = Array.isArray(inventory.params) ? inventory.params : [];
  const byId = new Map(params.map((p) => [p.id, p]));
  const physics = new Set(inventory.physicsOutputs || []);
  const controls = [];
  const unresolved = [];

  for (const [id, rule] of Object.entries(CHANNEL_BINDINGS)) {
    // 只有 direct 规则的 ids 是正则；compose 的 ids 是固定参数名，不参与匹配
    const unique = rule.mode === 'direct'
      ? [...new Set((rule.ids || []).flatMap((re) => params.filter((p) => re.test(p.id)).map((p) => p.id)))]
      : [];

    if (rule.mode === 'none') {
      controls.push(base(id, 'unsupported', 0, rule.reason));
      continue;
    }

    if (rule.mode === 'direct') {
      if (!unique.length) {
        controls.push(base(id, 'unsupported', 0, '模型里没有匹配到该语义所需的参数'));
        continue;
      }
      // 眨眼由引擎的 EyeBlink 组驱动，外部写只能抢一帧，按近似处理而不是 supported。
      const engineOwned = id === 'face.blink' && unique.every((pid) => CLOSED_EYES.test(pid));
      const owned = unique.some((pid) => physics.has(pid));
      controls.push({
        ...base(id, engineOwned ? 'approximate' : 'supported', engineOwned ? 0.7 : owned ? 0.8 : 0.95),
        sourceId: unique[0],
        resourceGroup: byId.get(unique[0])?.group || undefined,
        ownership: owned ? 'requires-own' : 'direct',
        reason: engineOwned
          ? '引擎眨眼组自动接管，外部写只在 own 期间有效'
          : owned
            ? '该参数是物理输出，必须 own 后才能写'
            : undefined,
      });
      continue;
    }

    if (rule.mode === 'compose') {
      const members = rule.ids || [];
      const present = members.filter((pid) => byId.has(pid));
      if (present.length !== members.length) {
        controls.push(base(id, 'unsupported', 0, `${rule.reason}；缺少参数 ${members.filter((p) => !byId.has(p)).join(',')}`));
        continue;
      }
      const owned = present.some((pid) => physics.has(pid));
      controls.push({
        ...base(id, 'approximate', 0.6, rule.reason),
        sourceId: present.join('+'),
        ownership: owned ? 'requires-own' : 'direct',
      });
      continue;
    }

    controls.push(base(id, 'unknown', 0, '该通道没有匹配规则，按 fail-closed 处理'));
    unresolved.push(id);
  }

  return { controls, unresolved };
}

function base(id, status, confidence, reason) {
  return {
    id,
    status,
    min: -1,
    max: 1,
    neutral: 0,
    confidence,
    ...(reason ? { reason } : {}),
  };
}
