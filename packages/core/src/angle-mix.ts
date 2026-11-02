/**
 * 同一参数多路加法叠加。
 *
 * 优先级高的通道先占额度；总和超出 cap 时，从低优先级开始削减。
 * 某一路写成 0 就不会残留。用于 AngleZ / PositionX / PositionY：
 * 身体跟随 > 待机微动作 > 媒体律动。
 */
export interface AngleLayer {
  id: string;
  /** 数值越大越优先保留 */
  priority: number;
  value: number;
}

export function mixAdditive(layers: AngleLayer[], cap: number): number {
  const limit = Math.abs(cap);
  if (!Number.isFinite(limit)) return 0;
  const ordered = [...layers].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  let sum = 0;
  for (const layer of ordered) {
    const value = Number.isFinite(layer.value) ? layer.value : 0;
    if (value === 0) continue;
    const next = sum + value;
    if (Math.abs(next) <= limit) {
      sum = next;
      continue;
    }
    const room = limit - Math.abs(sum);
    if (room <= 1e-8) break;
    // 反向可以先把已有偏移拉回来，再受 cap 约束
    if (sum !== 0 && Math.sign(value) !== Math.sign(sum)) {
      sum = Math.abs(next) <= limit ? next : limit * Math.sign(next);
      continue;
    }
    sum += Math.sign(value) * room;
  }
  if (Math.abs(sum) < 1e-8) return 0;
  return sum;
}
