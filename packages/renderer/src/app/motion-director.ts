/**
 * 成对动作（打开/关闭）的状态机与冲突仲裁。
 *
 * 这个模型的动作不是“一次性动作”，而是状态切换：手臂抬起来之后一直保持，
 * 直到播放对应的“关闭”。重复播放“打开”会看到手臂放下再抬起，必须幂等忽略。
 * “竖手指”和“狗尾巴草”共用右臂参数，同开会逐帧互抢，必须拒绝；
 * “抚胸手”用左臂，互不相交，可以共存。
 */

export type MotionSlotDir = 'open' | 'close';

export interface MotionDecision {
  status: 'ok' | 'skipped' | 'conflict' | 'normal';
  reason?: string;
  slot?: string;
  dir?: MotionSlotDir;
  targetGroup?: string;
}

interface PairedSlot {
  base: string;
  openGroup: string;
  closeGroup: string;
  /** 只取姿态骨；共用的光效/待机参数（如 Param56/57）不参与冲突判定。 */
  poseParams: string[];
}

const PAIRED_SLOTS: PairedSlot[] = [
  {
    base: '抚胸手',
    openGroup: '抚胸手打开',
    closeGroup: '抚胸手关闭',
    poseParams: ['Param59', 'Param60', 'Param61', 'Param62'],
  },
  {
    base: '竖手指',
    openGroup: '竖手指打开',
    closeGroup: '竖手指关闭',
    poseParams: ['Param36', 'Param39', 'Param40', 'Param41', 'Param42', 'Param43'],
  },
  {
    base: '狗尾巴草',
    openGroup: '狗尾巴草打开',
    closeGroup: '狗尾巴草关闭',
    poseParams: ['Param36', 'Param39', 'Param41', 'Param42', 'Param43'],
  },
];

function intersect(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((id) => set.has(id));
}

function slotForGroup(group: string): PairedSlot | null {
  if (!group) return null;
  for (const slot of PAIRED_SLOTS) {
    if (group === slot.openGroup || group === slot.closeGroup || group === slot.base) return slot;
  }
  return null;
}

/**
 * 两个动作是不是同一只手。
 * 同一对打开/关闭算同一只手；姿态骨相交（竖手指和狗尾巴草都是右臂）也算。
 * 收招逻辑来问这里，不要在 overlay 里再写一份左右手表。
 */
export function motionsShareArm(a: string, b: string): boolean {
  const left = slotForGroup(a);
  const right = slotForGroup(b);
  if (!left || !right) return false;
  if (left.base === right.base) return true;
  return intersect(left.poseParams, right.poseParams);
}

/**
 * 即将播放 group 前，需要先收尾的关闭动作。
 * 只收与 group 共用手臂、且当前为 open 的槽；同槽自己的打开/关闭不算。
 * 调用方应按返回顺序 awaitFinish 播完这些关闭，再播 group。不要全身清零。
 */
export function closesToPlayBefore(group: string, slotStates: Record<string, string> | null | undefined): string[] {
  if (!group) return [];
  const states = slotStates || {};
  const out: string[] = [];
  const incoming = slotForGroup(group);
  for (const slot of PAIRED_SLOTS) {
    if ((states[slot.base] || 'closed') !== 'open') continue;
    if (incoming && incoming.base === slot.base) continue;
    if (motionsShareArm(slot.openGroup, group)) out.push(slot.closeGroup);
  }
  return out;
}

/**
 * 该动作组对应的姿态骨。非成对动作返回空数组（调用方应自行决定清哪些参数）。
 */
export function poseParamsForGroup(group: string): string[] {
  const slot = slotForGroup(group);
  return slot ? slot.poseParams.slice() : [];
}

export class MotionDirector {
  private states = new Map<string, 'open' | 'closed'>();

  /** 解析请求；非成对动作返回 normal。 */
  public resolve(group: string): MotionDecision {
    for (const slot of PAIRED_SLOTS) {
      if (group === slot.openGroup || group === slot.base) {
        return { status: 'ok', slot: slot.base, dir: 'open', targetGroup: slot.openGroup };
      }
      if (group === slot.closeGroup) {
        return { status: 'ok', slot: slot.base, dir: 'close', targetGroup: slot.closeGroup };
      }
    }
    return { status: 'normal', targetGroup: group };
  }

  private conflictFor(requestSlot: string): MotionDecision | null {
    for (const slot of PAIRED_SLOTS) {
      if (slot.base === requestSlot) continue;
      if (this.states.get(slot.base) !== 'open') continue;
      const request = PAIRED_SLOTS.find((s) => s.base === requestSlot);
      if (request && intersect(request.poseParams, slot.poseParams)) {
        return {
          status: 'conflict',
          reason: `${slot.base} 正在占用同一批手臂参数，请先播放 ${slot.closeGroup}`,
          slot: requestSlot,
        };
      }
    }
    return null;
  }

  /** 只做判定，不真正启动动作；启动成功后再调 commit。 */
  public decide(group: string): MotionDecision {
    const resolved = this.resolve(group);
    if (resolved.status === 'normal') return resolved;

    const slotName = resolved.slot as string;
    const state = this.states.get(slotName) || 'closed';

    if (resolved.dir === 'open') {
      if (state === 'open') {
        return { status: 'skipped', reason: 'already-open', slot: slotName, dir: 'open', targetGroup: resolved.targetGroup };
      }
      const conflict = this.conflictFor(slotName);
      if (conflict) return conflict;
      return resolved;
    }

    if (state !== 'open') {
      return { status: 'skipped', reason: 'already-closed', slot: slotName, dir: 'close', targetGroup: resolved.targetGroup };
    }
    const conflict = this.conflictFor(slotName);
    if (conflict) return conflict;
    return resolved;
  }

  public commit(group: string): void {
    const resolved = this.resolve(group);
    if (resolved.status !== 'ok' || !resolved.slot) return;
    this.states.set(resolved.slot, resolved.dir === 'open' ? 'open' : 'closed');
  }

  public slotStates(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const slot of PAIRED_SLOTS) {
      result[slot.base] = this.states.get(slot.base) || 'closed';
    }
    return result;
  }

  public reset(): void {
    this.states.clear();
  }

  public sharesArm(a: string, b: string): boolean {
    return motionsShareArm(a, b);
  }
}
