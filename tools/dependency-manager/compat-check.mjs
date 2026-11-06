// compat-check.mjs — 兼容性检查：Node engines / peerDeps 冲突 / npm audit 解析
import { readFile } from 'node:fs/promises';
import { satisfiesEngines, satisfiesRange } from './version-resolver.mjs';
import { runNpm, viewPackage } from './npm-registry.mjs';

/**
 * engines 检查：候选包的 engines.node 范围 vs 当前 Node 版本。
 * 返回 { ok, reason }；ok=false 时不建议安装。
 */
export function checkNodeEngines(engines, nodeVersion = process.version) {
  if (!engines || !engines.node) return { ok: true, reason: 'no engines constraint' };
  const ok = satisfiesEngines(nodeVersion, engines.node);
  return {
    ok: ok === true,
    reason: ok === true
      ? `node ${nodeVersion} satisfies ${engines.node}`
      : ok === false
        ? `node ${nodeVersion} does not satisfy engines.node ${engines.node}`
        : `unsupported engines range: ${engines.node}`,
  };
}

/**
 * peerDependencies 冲突识别。
 * @param peerDeps   候选版本的 peerDependencies（{peer: range}）
 * @param peerMeta   peerDependenciesMeta（可选 peer 标记）
 * @param installedMap 本机已装版本 {peer: version|null}
 * 返回 { ok, conflicts: [{peer, range, installed, reason}] }
 */
export function checkPeerDeps(peerDeps = {}, peerMeta = {}, installedMap = {}) {
  const conflicts = [];
  for (const [peer, range] of Object.entries(peerDeps)) {
    const optional = peerMeta[peer] && peerMeta[peer].optional === true;
    const installed = Object.prototype.hasOwnProperty.call(installedMap, peer) ? installedMap[peer] : null;
    if (installed === null || installed === undefined) {
      if (!optional) {
        conflicts.push({ peer, range, installed: null, reason: 'peer missing and not optional' });
      }
      continue;
    }
    const sat = satisfiesRange(installed, range);
    if (sat === false) {
      conflicts.push({ peer, range, installed, reason: `installed ${installed} does not satisfy ${range}` });
    } else if (sat === null) {
      conflicts.push({ peer, range, installed, reason: `unsupported range syntax: ${range} (manual review)` });
    }
  }
  return { ok: conflicts.length === 0, conflicts };
}

/**
 * 取候选版本的 engines + peerDependencies 并做兼容性检查。
 * installedMap 缺省时由 projectDir 的 package.json 依赖 spec 近似（保守：spec 不是精确版本时视为未知，交给冲突列表人工复核）。
 */
export async function checkCompatibility(pkg, version, { projectDir, installedMap, nodeVersion } = {}) {
  const info = await viewPackage(pkg, version, ['engines', 'peerDependencies', 'peerDependenciesMeta']);
  const engines = checkNodeEngines(info.engines, nodeVersion);

  let depsMap = installedMap;
  if (!depsMap && projectDir) {
    try {
      const raw = JSON.parse(await readFile(`${projectDir}/package.json`.replaceAll('\\', '/'), 'utf8'));
      depsMap = { ...(raw.dependencies || {}), ...(raw.devDependencies || {}) };
    } catch {
      depsMap = {};
    }
  }
  depsMap = depsMap || {};
  // spec（如 ^1.2.3）不能当已安装版本用——保留精确语义的才有判定价值，其余按 missing 处理。
  const normalized = {};
  for (const [k, v] of Object.entries(depsMap)) {
    normalized[k] = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
  }
  const peers = checkPeerDeps(info.peerDependencies || {}, info.peerDependenciesMeta || {}, normalized);

  return { ok: engines.ok && peers.ok, engines, peers, peerDeps: info.peerDependencies || {} };
}

/**
 * npm audit（只读，best-effort）。项目无有效 lockfile / registry 异常时返回 unavailable，
 * 不阻塞 check；update 事务里 unavailable 视为需人工确认。
 */
export async function runAudit(projectDir, { timeoutMs = 120_000 } = {}) {
  try {
    const out = await runNpm(['audit', '--json'], { cwd: projectDir, timeoutMs });
    const data = JSON.parse(out);
    const meta = data.metadata && data.metadata.vulnerabilities ? data.metadata.vulnerabilities : {};
    return {
      available: true,
      vulnerabilities: meta,
      advisories: Object.values(data.vulnerabilities || {})
        .filter((v) => v.via && v.via.some((x) => typeof x === 'object'))
        .map((v) => ({ name: v.name, severity: v.severity, range: v.range })),
    };
  } catch (err) {
    const stdout = err.cause && err.cause.stdout ? err.cause.stdout : '';
    if (stdout) {
      try {
        const data = JSON.parse(stdout);
        const meta = data.metadata && data.metadata.vulnerabilities ? data.metadata.vulnerabilities : {};
        return { available: true, vulnerabilities: meta, advisories: [] };
      } catch { /* fallthrough */ }
    }
    return { available: false, reason: (err.message || '').slice(0, 200) };
  }
}
