/**
 * dsh-l2d · 工具链状态读取（l2d_toolchain_status 的数据源）
 *
 * 只读。读不到库/表时如实返回 ok:false，不编造状态。
 */
import { openDb } from '../../dsh-l2d-db/src/db.mjs';
import { toolchainSnapshot } from '../../dsh-l2d-db/src/repo.mjs';

/**
 * @param {{dbPath?: string, startDir?: string}} [options]
 * @returns {{ok: boolean, dbPath?: string, components?: object[], reason?: string}}
 */
export function readToolchainStatus(options = {}) {
  let db = null;
  try {
    db = openDb({ path: options.dbPath, startDir: options.startDir });
    const components = toolchainSnapshot(db);
    const verified = components.filter((c) => c.status === 'present_verified').length;
    return {
      ok: true,
      summary: {
        total: components.length,
        presentVerified: verified,
        degraded: components.filter((c) => c.status === 'present_unverified').length,
        missing: components.filter((c) => c.status === 'missing').length,
      },
      components,
    };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err).slice(0, 300) };
  } finally {
    try { if (db) db.close(); } catch { /* 忽略 */ }
  }
}
