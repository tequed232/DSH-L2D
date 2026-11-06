// cli.mjs — node tools/dependency-manager/cli.mjs <check|update|rollback|audit>
// 用法：
//   node tools/dependency-manager/cli.mjs check [--dir <projectDir>] [pkg]
//   node tools/dependency-manager/cli.mjs update <pkg>@<exact-version> [--dir <dir>] [--approve]
//   node tools/dependency-manager/cli.mjs rollback [pkg] [--dir <dir>] [--approve]
//   node tools/dependency-manager/cli.mjs audit [--dir <dir>]        # 只读 npm audit
//   node tools/dependency-manager/cli.mjs history [--dir <dir>] [--limit N]  # 审计记录
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DependencyManager, DEFAULT_CONFIG } from './dependency-manager.mjs';
import { writeConfig } from './dependency-manager.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_DATA_DIR = join(REPO_ROOT, 'data', 'dependency-manager');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--approve') args.approve = true;
    else if (a === '--limit') args.limit = Number(argv[++i]) || 20;
    else args._.push(a);
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node tools/dependency-manager/cli.mjs check [--dir <projectDir>] [pkg]
  node tools/dependency-manager/cli.mjs update <pkg>@<exact-version> [--dir <dir>] [--approve]
  node tools/dependency-manager/cli.mjs rollback [pkg] [--dir <dir>] [--approve]
  node tools/dependency-manager/cli.mjs audit [--dir <dir>]
  node tools/dependency-manager/cli.mjs history [--dir <dir>] [--limit N]
  node tools/dependency-manager/cli.mjs init-config`);
}

function printScanRows(rows) {
  const width = (rows) => Math.max(...rows.map((r) => r.length), 3);
  const cols = ['pkg', 'spec', 'installed', 'latest', 'level'];
  const w = Object.fromEntries(cols.map((c) => [c, width(rows.map((r) => String(r[c] ?? '-')))]));
  const line = (cells) => cells.map((c, i) => String(c ?? '-').padEnd(w[cols[i]])).join('  ');
  console.log(line(cols));
  for (const r of rows) console.log(line([r.pkg, r.spec, r.installed, r.latest, r.level + (r.prerelease ? ' (prerelease)' : '') + (r.error ? ' (error)' : '')]));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const projectDir = resolve(args.dir || REPO_ROOT);
  const mgr = new DependencyManager({ projectDir, dataDir: DEFAULT_DATA_DIR });

  switch (cmd) {
    case 'check': {
      const [pkg] = args._;
      const rows = pkg ? [await mgr.checkOne(pkg)] : await mgr.check();
      const upgradable = rows.filter((r) => r.level === 'major' || r.level === 'minor' || r.level === 'patch');
      console.log(`\ncheck: ${projectDir}`);
      printScanRows(rows);
      console.log(`\ntotal ${rows.length}; upgradable ${upgradable.length} `
        + `(major ${rows.filter((r) => r.level === 'major').length}`
        + ` / minor ${rows.filter((r) => r.level === 'minor').length}`
        + ` / patch ${rows.filter((r) => r.level === 'patch').length})`);
      console.log('mode: read-only scan (results cached in data/dependency-manager/dependency-cache.sqlite)');
      break;
    }
    case 'update': {
      const target = args._[0];
      const m = /^(@?[^@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(target || '');
      if (!m) {
        console.error('error: expected <pkg>@<exact-version>, e.g. lodash@4.17.21');
        process.exitCode = 2;
        break;
      }
      const [, pkg, version] = m;
      try {
        const res = await mgr.update(pkg, version, { approved: args.approve === true });
        console.log(`OK  ${pkg}: ${res.oldVersion} -> ${res.newVersion} (${res.durationMs}ms, backup: ${res.backupDir})`);
      } catch (err) {
        console.error(`update failed [${err.code || 'ERROR'}]: ${err.message}`);
        process.exitCode = 1;
      }
      break;
    }
    case 'rollback': {
      try {
        const res = await mgr.rollback(args._[0] || undefined, { approved: args.approve === true });
        console.log(`OK  rollback ${res.pkg}: ${res.restoredFrom} -> ${res.restoredTo}; restored: ${res.restored.join(', ')}`);
      } catch (err) {
        console.error(`rollback failed [${err.code || 'ERROR'}]: ${err.message}`);
        process.exitCode = 1;
      }
      break;
    }
    case 'audit': {
      const res = await mgr.securityAudit();
      console.log(`npm audit (${projectDir}): ${res.available ? 'available' : `unavailable (${res.reason})`}`);
      if (res.available) console.log(JSON.stringify(res.vulnerabilities));
      break;
    }
    case 'history': {
      const rows = mgr.listAudit({ limit: args.limit });
      for (const r of rows) {
        console.log(`#${r.id} ${r.ts} ${r.pkg} ${r.old_version} -> ${r.new_version} level=${r.level ?? '-'} result=${r.result} ${r.duration_ms ?? '-'}ms`);
      }
      if (rows.length === 0) console.log('(no history)');
      break;
    }
    case 'init-config': {
      writeConfig(DEFAULT_DATA_DIR, DEFAULT_CONFIG);
      console.log(`config written: ${join(DEFAULT_DATA_DIR, 'config.json')}`);
      break;
    }
    default:
      printUsage();
      process.exitCode = cmd ? 2 : 0;
  }
  mgr.close();
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exitCode = 1;
});
