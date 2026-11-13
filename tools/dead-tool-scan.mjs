import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const walk = (d, out = []) => {
  let entries;
  try {
    entries = readdirSync(d);
  } catch {
    return out;
  }
  for (const f of entries) {
    if (['node_modules', '.git', 'dist'].includes(f)) continue;
    const p = join(d, f);
    try {
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(m?js|ts|tsx)$/.test(f)) out.push(p);
    } catch {
      /* 不可读的跳过 */
    }
  }
  return out;
};

// 1. 工具表：取 MCP server 里所有 l2d_ 工具名
const server = readFileSync('packages/dsh-l2d-mcp/src/server.mjs', 'utf8');
const tools = [...new Set(server.match(/l2d_[a-z0-9_]+/g))];

// 2. 渲染端 + 插件端 + 宿主：统计非 MCP、非测试、非文档的出现位置
const files = [...walk('packages/renderer/src'), ...walk('packages/dsh-l2d-plugin'), ...walk('packages/mcp-bridge')].filter(
  (f) => !/test|\.spec\./.test(f),
);

for (const t of tools.sort()) {
  const hits = files.filter((f) => readFileSync(f, 'utf8').includes(t));
  console.log(`${t}\t${hits.length ? hits.join(', ') : 'NO_CONSUMER'}`);
}
