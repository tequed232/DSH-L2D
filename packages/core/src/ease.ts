/**
 * 三次缓入缓出。姿势切换和微动作共用，避免线性插值的生硬感。
 * t 会被钳到 0~1。
 */
export function easeInOutCubic(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
}
