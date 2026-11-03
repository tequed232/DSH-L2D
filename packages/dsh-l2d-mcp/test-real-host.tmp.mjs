/** l2d_agent_action 真机端到端测试（临时文件，测完即删）。直连 11567 上游宿主。 */
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:3081';
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'),
  env: { ...process.env, DSH_L2D_URL: BASE },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* 忽略 */ }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[mcp-err] ' + d));
let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(400);

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// 场景 A：任务指定样例 → 真机完整链路
const a = await rpc('tools/call', {
  name: 'l2d_agent_action',
  arguments: { action: { name: 'l2d_look_at', parameters: { x: 0.3 } }, userIntent: '看右侧', waitMs: 8000 },
});
console.log('== A isError:', a.result?.isError);
console.log('== A envelope:', a.result?.content?.[0]?.text);

// 场景 B：waitMs=0 → 立即返回非终态信封
const b = await rpc('tools/call', {
  name: 'l2d_agent_action',
  arguments: { action: { name: 'l2d_look_at', parameters: { x: 0 } }, userIntent: '立即返回', waitMs: 0 },
});
console.log('== B envelope:', b.result?.content?.[0]?.text);

// 场景 C：白名单外动作名 → 宿主守卫 rejected（正常结果）
const c = await rpc('tools/call', {
  name: 'l2d_agent_action',
  arguments: { action: { name: 'l2d_not_in_host_list' }, userIntent: '越权测试', waitMs: 8000 },
});
console.log('== C isError:', c.result?.isError);
console.log('== C envelope:', c.result?.content?.[0]?.text);

// 场景 D：workspaceNote → stateSummary
const d = await rpc('tools/call', {
  name: 'l2d_agent_action',
  arguments: { action: { name: 'l2d_say', parameters: { text: '真机协议链路测试' } }, userIntent: '打招呼', workspaceNote: 'MCP 端到端自检', waitMs: 8000 },
});
console.log('== D envelope:', d.result?.content?.[0]?.text);

child.kill();
process.exit(0);
