// 证据脚本：persona 改完 → 桥下一次 refresh 立即用新值（getPersona 每次重读，无缓存）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPersona, resetPersona, writePersona } from '../packages/dsh-l2d-plugin/lib/persona.mjs';
import { createWorkspaceAgentBridge } from '../packages/dsh-l2d-plugin/lib/workspace-agent.mjs';

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-persona-demo-'));
const workspace = { id: 'workspace-live2d', title: 'Live2D Agent', sessionIds: [] };
const ctx = {
  workspaceRegistry: {
    async create() { return workspace; },
  },
  sessionController: {
    async create() { workspace.sessionIds = ['session-live2d']; return { sessionId: 'session-live2d' }; },
    async prompt() { return { accepted: true }; },
  },
};

const bridge = createWorkspaceAgentBridge({
  ctx,
  homeDir,
  getSnapshot: async () => ({ ok: true, generatedAt: new Date().toISOString(), workspaces: [{ workspaceId: 'other', title: 'Other', sessions: [{ sessionIndex: 1, state: 'working', ageMs: 1000 }] }] }),
  getPersona: () => readPersona({ homeDir }),
  intervalMs: 600000,
});

await bridge.ensure();
const agentMd = () => fs.readFileSync(path.join(homeDir, 'workspaces/live2d-agent/agent.md'), 'utf8');

// 1. 默认人设先落地
assert.ok(agentMd().includes('未填写自由描述'), '初始 agent.md 应含默认人设');
console.log('1) 初始 persona: description =', JSON.stringify(readPersona({ homeDir }).description));

// 2. 改人设 → 下一次 refresh 立即生效（无重启、无缓存）
writePersona({ traits: ['温柔', '傲娇'], description: '一只温柔但有点傲娇的蓝鲸女仆' }, { homeDir });
await bridge.refresh(false);
const after = agentMd();
assert.ok(after.includes('温柔但有点傲娇的蓝鲸女仆'), 'agent.md 必须包含新描述');
console.log('2) 写入后下一次 refresh：agent.md 含新描述 =', after.includes('温柔但有点傲娇的蓝鲸女仆'));
console.log('   读取值 =', JSON.stringify(readPersona({ homeDir }).traits), '/', JSON.stringify(readPersona({ homeDir }).description));

// 3. 再改一次，立即再生效
writePersona({ expression: { style: 'tsundere', intensity: 0.9 } }, { homeDir });
await bridge.refresh(false);
assert.ok(agentMd().includes('tsundere'), 'agent.md 必须包含新的表达风格');
console.log('3) 二次修改：agent.md 含 tsundere =', agentMd().includes('tsundere'));

// 4. reset 也立即生效
resetPersona({ homeDir });
await bridge.refresh(false);
assert.ok(agentMd().includes('未填写自由描述'));
console.log('4) reset 后 agent.md 回默认 =', agentMd().includes('未填写自由描述'));

bridge.dispose();
fs.rmSync(homeDir, { recursive: true, force: true });
console.log('persona-immediate-effect: ok');
