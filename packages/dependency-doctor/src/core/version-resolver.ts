/**
 * 轻量版本比较（零依赖）。
 * 支持 ">=x.y"、"x.y.z"、"*"；足够覆盖 registry 的 requiredVersion 形态。
 */

export function parseVersion(v: string): number[] {
  const cleaned = String(v || '').replace(/[^0-9.]/g, '');
  const parts = cleaned.split('.').filter((s) => s !== '');
  if (!parts.length) return [0];
  return parts.map((n) => parseInt(n, 10) || 0);
}

function compare(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** required 形如 ">=1.2" / "1.2.3" / "*"；detected 为实际版本串。 */
export function satisfies(required: string, detected: string): boolean {
  const req = String(required || '').trim();
  if (!req || req === '*' || req === 'latest') return true;
  if (!detected) return false;
  const ge = req.match(/^>=\s*(.+)$/);
  const gt = req.match(/^>\s*(.+)$/);
  const eq = req.match(/^=\s*(.+)$/);
  const a = parseVersion(detected);
  if (ge) return compare(a, parseVersion(ge[1])) >= 0;
  if (gt) return compare(a, parseVersion(gt[1])) > 0;
  if (eq) return compare(a, parseVersion(eq[1])) === 0;
  return compare(a, parseVersion(req)) === 0;
}
