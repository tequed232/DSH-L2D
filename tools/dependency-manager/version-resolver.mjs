// version-resolver.mjs — SemVer 解析 / 比较 / 分级识别 / 范围满足判定
// 规则遵循 semver.org：主/次/补丁数值比较；prerelease 低于对应 release；
// prerelease 标识符按「数字 < 字符串、数字按数值、字符串按 ASCII、集合短者小」比较。
// 禁止字符串直接比较版本号。

/** 解析版本号为 {major,minor,patch,prerelease,raw}，非法返回 null */
export function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (!m) return null;
  const s = raw.trim();
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    raw: s.startsWith('v') ? s.slice(1) : s,
  };
}

function cmpPrerelease(a, b) {
  // 无 prerelease 的 release 更大
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1; // 集合短者小（前缀相等时）
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // 数字标识符 < 字符串标识符
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** 比较两个版本，返回 -1/0/1；任一非法返回 null */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  return cmpPrerelease(va.prerelease, vb.prerelease);
}

/** 已安装版本 → 最新稳定版的更新级别 */
export function diffLevel(installed, latest) {
  const vi = parseVersion(installed);
  const vl = parseVersion(latest);
  if (!vi || !vl) return { level: 'unknown', prerelease: false };
  if (compareVersions(installed, latest) >= 0) return { level: 'latest', prerelease: vl.prerelease.length > 0 };
  const level =
    vl.major > vi.major ? 'major'
    : vl.minor > vi.minor ? 'minor'
    : 'patch';
  return { level, prerelease: vl.prerelease.length > 0 };
}

// ---------- 范围判定（支持 ^ ~ 比较器 / x-range / || / 精确版本） ----------

function nextVersion(v, kind) {
  // kind: 'major' | 'minor' | 'patch' —— 返回上界
  if (kind === 'major') return `${v.major + 1}.0.0`;
  if (kind === 'minor') return `${v.major}.${v.minor + 1}.0`;
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

/** 单个比较器与版本的满足判定（含 prerelease 语义：仅同 [major,minor,patch] 元组的 prerelease 可命中） */
function cmpSatisfies(v, op, rangeRaw) {
  const rv = parseVersion(rangeRaw);
  if (!rv) return null;
  // prerelease 门槛：目标为 prerelease 时，必须与比较器版本同元组（x-range 按 0 填充后同元组）
  if (v.prerelease.length > 0) {
    const tuple = [rv.major, rv.minor, rv.patch];
    if (v.major !== tuple[0] || v.minor !== tuple[1] || v.patch !== tuple[2]) return false;
  }
  const c = compareVersions(v.raw, rangeRaw);
  switch (op) {
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    case '=': return c === 0;
    default: return null;
  }
}

/** 解析一个 AND 组（空格分隔的比较器/范围写法）为若干 {op, raw} 原子，不合法返回 null */
function parseGroup(group) {
  const atoms = [];
  for (const part of group.trim().split(/\s+/)) {
    if (part === '' || part === '||') continue;
    let m = /^(>=|<=|[\^~>=<*])?\s*(.*)$/.exec(part);
    if (!m) return null;
    let op = m[1] || '';
    let ver = m[2];
    if (ver === '' || ver === '*' || ver === 'x' || ver === 'X') {
      atoms.push({ op: '>=', raw: '0.0.0' });
      continue;
    }
    // 带比较器 op 的部分版本（如 >=20、<23）：零填充为精确版本（missing 位 = 0）
    if (['>=', '<=', '>', '<', '='].includes(op) && /^v?\d+(\.\d+)*$/.test(ver) && !/^\d+\.\d+\.\d+$/.test(ver)) {
      const parts = ver.replace(/^v/, '').split('.');
      while (parts.length < 3) parts.push('0');
      ver = parts.join('.');
    }
    // x-range：1.x / 1.2.x / 1.2
    const xr = /^(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(ver);
    if (xr) {
      const segs = [xr[1], xr[2], xr[3]].map((s) => (s === undefined ? undefined : s));
      const num = (s) => (s === undefined || s === 'x' || s === 'X' || s === '*' ? null : Number(s));
      const M = num(segs[0]) ?? 0;
      const mnr = num(segs[1]);
      const p = num(segs[2]);
      const isX = (s) => s === undefined || s === 'x' || s === 'X' || s === '*';
      if (isX(segs[0])) {
        atoms.push({ op: '>=', raw: '0.0.0' });
        continue;
      }
      if (isX(segs[1])) {
        atoms.push({ op: '>=', raw: `${M}.0.0` });
        atoms.push({ op: '<', raw: `${M + 1}.0.0` });
        continue;
      }
      if (isX(segs[2])) {
        atoms.push({ op: '>=', raw: `${M}.${mnr}.0` });
        atoms.push({ op: '<', raw: `${M}.${mnr + 1}.0` });
        continue;
      }
      ver = `${M}.${mnr}.${p}${xr[4] ? `-${xr[4]}` : ''}`;
    }
    // 部分版本比较器（如 >=20、<23、~20）：零填充到 x.y.z；~20 语义为 >=20.0.0 <21.0.0
    if (!parseVersion(ver)) {
      const pm = /^v?(\d+)(?:\.(\d+))?$/.exec(ver);
      if (pm) {
        ver = pm[2] === undefined ? `${pm[1]}.0.0` : `${pm[1]}.${pm[2]}.0`;
        if (op === '~' && pm[2] === undefined) op = '^';
      }
    }
    if (op === '^') {
      const v = parseVersion(ver);
      if (!v) return null;
      atoms.push({ op: '>=', raw: ver });
      const upperKind = v.major > 0 ? 'major' : v.minor > 0 ? 'minor' : 'patch';
      atoms.push({ op: '<', raw: nextVersion(v, upperKind) });
      continue;
    }
    if (op === '~') {
      const v = parseVersion(ver);
      if (!v) return null;
      atoms.push({ op: '>=', raw: ver });
      atoms.push({ op: '<', raw: nextVersion(v, 'minor') });
      continue;
    }
    if (op === '<*') return null;
    atoms.push({ op: op === '' ? '=' : op, raw: ver });
  }
  return atoms;
}

/**
 * 判定 version 是否满足 range（node-semver 子集：^ ~ 比较器 / > >= < <= = / x-range / || / 精确）。
 * 不支持的写法返回 null（调用方按未知处理，不得默认通过）。
 */
export function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (!v || typeof range !== 'string') return null;
  for (const group of range.split('||')) {
    const atoms = parseGroup(group);
    if (atoms === null) return null; // 含未支持写法，整体未知
    if (atoms.length === 0) return true; // '*'
    const verdicts = atoms.map((a) => cmpSatisfies(v, a.op, a.raw));
    if (verdicts.some((x) => x === null)) return null; // 含未支持写法，按未知处理
    if (verdicts.every((x) => x === true)) return true;
    // 本组不满足 → 继续尝试下一组（||）
  }
  return false;
}

/** engines.node 范围检查：返回 true/false/null（null = 范围写法不支持） */
export function satisfiesEngines(nodeVersion, enginesRange) {
  if (!enginesRange) return true;
  return satisfiesRange(nodeVersion, enginesRange);
}
