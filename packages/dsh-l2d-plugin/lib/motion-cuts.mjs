/**
 * 动作衔接点自动检测（兜底用；有 motion-cutpoints.json 标注的动作以标注为准）。
 *
 * 纯函数部分：给一份 motion3.json 内容和要看的参数，按曲线速度找「各参数都接近静止」的时刻。
 *   - 每条曲线按自身振幅归一化，取所有曲线的最大速度；
 *   - 速度低于本动作峰值 × ratio（缺省 0.25）且持续 ≥ minRunMs（缺省 100）的时间窗，取窗口起点为衔接点；
 *   - 去重并保证相邻衔接点间隔 ≥ minGapMs（缺省 250）；
 *   - Movement* 这类 0/1 开关曲线、阶梯段不计入速度。
 * 运行时由宿主从许可模型目录读 motion3.json 现算，结果不落盘、不入库。
 */
import fs from 'node:fs';
import path from 'node:path';

function segmentSampler(seg) {
  const parts = [];
  if (!Array.isArray(seg) || seg.length < 2) return () => 0;
  let p = [Number(seg[0]), Number(seg[1])];
  let i = 2;
  while (i < seg.length) {
    const type = seg[i];
    if (type === 1) {
      const c = seg.slice(i + 1, i + 7).map(Number);
      parts.push({ type, p0: p, c1: [c[0], c[1]], c2: [c[2], c[3]], p1: [c[4], c[5]] });
      p = [c[4], c[5]];
      i += 7;
    } else {
      const p1 = [Number(seg[i + 1]), Number(seg[i + 2])];
      parts.push({ type, p0: p, p1 });
      p = p1;
      i += 3;
    }
  }
  const first = [Number(seg[0]), Number(seg[1])];
  return (t) => {
    if (t <= first[0]) return first[1];
    for (const s of parts) {
      if (t > s.p1[0]) continue;
      const span = s.p1[0] - s.p0[0] || 1;
      const u = (t - s.p0[0]) / span;
      if (s.type === 0) return s.p0[1] + (s.p1[1] - s.p0[1]) * u;
      if (s.type === 2) return s.p0[1];
      if (s.type === 3) return s.p1[1];
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 24; k++) {
        const m = (lo + hi) / 2;
        const x = (1 - m) ** 3 * s.p0[0] + 3 * (1 - m) ** 2 * m * s.c1[0] + 3 * (1 - m) * m * m * s.c2[0] + m ** 3 * s.p1[0];
        if (x < t) lo = m;
        else hi = m;
      }
      const m = lo;
      return (1 - m) ** 3 * s.p0[1] + 3 * (1 - m) ** 2 * m * s.c1[1] + 3 * (1 - m) * m * m * s.c2[1] + m ** 3 * s.p1[1];
    }
    return parts.length ? parts[parts.length - 1].p1[1] : first[1];
  };
}

function isSteppedOnly(seg) {
  for (let i = 2; i < seg.length; ) {
    const type = seg[i];
    if (type === 0 || type === 1) return false;
    i += type === 1 ? 7 : 3;
  }
  return true;
}

/**
 * @param {object} motion3 motion3.json 内容
 * @param {{params?: string[], ratio?: number, minRunMs?: number, minGapMs?: number, fps?: number}} [opts]
 * @returns {{durationMs:number, loop:boolean, cutPointsMs:number[]}}
 */
export function computeCutPoints(motion3, opts = {}) {
  const meta = (motion3 && motion3.Meta) || {};
  const D = Number(meta.Duration) || 0;
  const fps = opts.fps || 30;
  const ratio = opts.ratio === undefined ? 0.25 : opts.ratio;
  const minRunMs = opts.minRunMs === undefined ? 100 : opts.minRunMs;
  const minGapMs = opts.minGapMs === undefined ? 250 : opts.minGapMs;
  const only = Array.isArray(opts.params) && opts.params.length ? new Set(opts.params) : null;
  const curves = [];
  for (const c of Array.isArray(motion3 && motion3.Curves) ? motion3.Curves : []) {
    if (!c || c.Target !== 'Parameter' || !Array.isArray(c.Segments)) continue;
    if (/^Movement/.test(String(c.Id)) || isSteppedOnly(c.Segments)) continue;
    if (only && !only.has(c.Id)) continue;
    const f = segmentSampler(c.Segments);
    const vs = [];
    for (let k = 0; k <= Math.floor(D * fps); k++) vs.push(f(k / fps));
    const amp = Math.max(...vs) - Math.min(...vs);
    if (amp > 1e-6) curves.push({ vs, amp });
  }
  const out = { durationMs: Math.round(D * 1000), loop: meta.Loop === true, cutPointsMs: [] };
  const n = Math.floor(D * fps) + 1;
  if (!curves.length || n < 2) return out;
  const speed = [];
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (const c of curves) {
      const a = c.vs[Math.max(0, k - 1)];
      const b = c.vs[Math.min(c.vs.length - 1, k + 1)];
      s = Math.max(s, Math.abs(b - a) / (2 / fps) / c.amp);
    }
    speed.push(s);
  }
  const peak = Math.max(...speed);
  const cuts = [];
  let st = null;
  for (let k = 0; k < n; k++) {
    const calm = speed[k] < ratio * peak;
    if (calm && st === null) st = k;
    if ((!calm || k === n - 1) && st !== null) {
      const en = calm ? k : k - 1;
      if (((en - st) / fps) * 1000 >= minRunMs) cuts.push(Math.round((st / fps) * 1000));
      st = null;
    }
  }
  for (const ms of cuts.sort((a, b) => a - b)) {
    const last = out.cutPointsMs[out.cutPointsMs.length - 1];
    if (last === undefined || ms - last >= minGapMs) out.cutPointsMs.push(ms);
  }
  return out;
}

/**
 * 从许可模型目录现算各动作组的衔接点（只算 wanted 里的组；读不到就跳过，不抛）。
 * @param {string} modelDir 模型目录（含 <modelId>.model3.json）
 * @param {string} modelId
 * @param {(group:string)=>string[]} paramsOf 动作所属模块的参数
 * @param {string[]} wanted 要算的动作组
 */
export function autoCutsForModel(modelDir, modelId, paramsOf, wanted, fsImpl = fs) {
  const out = {};
  if (!modelDir || !modelId || !Array.isArray(wanted) || !wanted.length) return out;
  let model3;
  try {
    model3 = JSON.parse(fsImpl.readFileSync(path.join(modelDir, modelId + '.model3.json'), 'utf8'));
  } catch {
    return out;
  }
  const motions = (model3 && model3.FileReferences && model3.FileReferences.Motions) || {};
  for (const group of wanted) {
    const entry = Array.isArray(motions[group]) ? motions[group][0] : null;
    if (!entry || typeof entry.File !== 'string') continue;
    const file = path.resolve(modelDir, entry.File);
    if (!file.startsWith(path.resolve(modelDir) + path.sep)) continue;
    try {
      const m3 = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      out[group] = { ...computeCutPoints(m3, { params: paramsOf(group) }), fadeInMs: Number.isFinite(Number(entry.FadeInTime)) ? Math.round(Number(entry.FadeInTime) * 1000) : undefined };
    } catch {
      // 读不到就没有兜底数据：调用方按 600ms 上限处理
    }
  }
  return out;
}
