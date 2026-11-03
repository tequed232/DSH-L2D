import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceAgentBridge } from './workspace-agent.mjs';
import { analyzeContext } from './context-analyzer.mjs';
import { summarizeSession } from './session-events.mjs';
import { buildWorkspaceContextSnapshot, renderSnapshotContext } from './workspace-snapshot.mjs';

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-workspace-'));
const workspace = { id: 'workspace-live2d', title: 'Live2D Agent', sessionIds: [] };
const calls = [];
const ctx = {
  workspaceRegistry: {
    async create(directory, title) {
      assert.equal(directory, path.join(homeDir, 'workspaces', 'live2d-agent'));
      assert.equal(title, 'Live2D Agent');
      return workspace;
    }
  },
  sessionController: {
    async create(request) {
      assert.equal(request.agentPreset, 'dsh-l2d');
      calls.push(['create', request]);
      workspace.sessionIds = ['session-live2d'];
      return { sessionId: 'session-live2d' };
    },
    async prompt(request) {
      calls.push(['prompt', request]);
      return { accepted: true };
    }
  }
};
const snapshot = {
  ok: true,
  generatedAt: '2026-11-02T00:00:00.000Z',
  workspaces: [{
    workspaceId: 'workspace-other',
    title: 'Other project',
    sessions: [{ sessionId: 'session-other', state: 'working', ageMs: 1000 }]
  }]
};

// W1：构造一份快照（等审批情境）供规划上下文使用。
const t0 = 1793700000000;
const wsSummary = summarizeSession(
  [
    { type: 'user/message', time: t0, data: { content: [{ type: 'text', text: '用户原话不该进 prompt' }] } },
    { type: 'tool/call', time: t0 + 10, data: { callId: 'c1', name: 'bash' } },
    { type: 'approval/asked', time: t0 + 20, data: { id: 'ap1', toolName: 'bash', callId: 'c1', reason: 'token=secret' } },
    { type: 'job/registered', time: t0 + 30, data: { jobId: 'j1', kind: 'bash', label: 'rm -rf /', startedAt: t0 + 30 } },
  ],
  { now: t0 + 100 },
);
const presence = { available: true, stale: false, ageMs: 500, state: 'work', payload: { state: 'work', away: false, idleMs: 1200, inputFocused: false } };
const wsSnapshot = buildWorkspaceContextSnapshot({
  sessionId: 'session-live2d',
  summary: wsSummary,
  presence,
  activity: analyzeContext({ summary: wsSummary, presence, now: t0 + 100 }),
  now: t0 + 100,
  unavailable: [{ path: 'changedFiles.fileCount', reason: 'not-wired' }],
});

const bridge = createWorkspaceAgentBridge({
  ctx,
  homeDir,
  getSnapshot: async () => snapshot,
  getWorkspaceSnapshot: async () => wsSnapshot,
  intervalMs: 60000,
});
try {
  const result = await bridge.ensure();
  assert.equal(result.ok, true);
  assert.equal(result.workspaceId, 'workspace-live2d');
  assert.equal(result.sessionId, 'session-live2d');
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'prompt').length, 1);
  const instructions = fs.readFileSync(path.join(result.workspacePath, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /Live2D character agent/);
  assert.match(instructions, /mcp__dsh_l2d__l2d_act/);
  const status = fs.readFileSync(path.join(result.workspacePath, 'agent.md'), 'utf8');
  assert.match(status, /Other project/);
  assert.match(status, /working/);
  assert.doesNotMatch(status, /session-other/);

  // W1：bootstrap prompt 里带「结构化事实 / 推断 / 不可得」三段，且不含原始内容。
  const bootstrapPrompt = calls.find(([kind]) => kind === 'prompt')[1].content[0].text;
  assert.match(bootstrapPrompt, /结构化事实：/);
  assert.match(bootstrapPrompt, /推断（低置信不得当事实用）：/);
  assert.match(bootstrapPrompt, /不可得（不要猜测，也不要当 idle 或成功）：/);
  assert.match(bootstrapPrompt, /activity\.situation=waiting_for_approval/);
  assert.equal(bootstrapPrompt.includes('用户原话不该进 prompt'), false);
  assert.equal(bootstrapPrompt.includes('token=secret'), false);
  assert.equal(bootstrapPrompt.includes('rm -rf /'), false);

  const again = await bridge.ensure();
  assert.equal(again.sessionId, 'session-live2d');
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);

  // W1：/workspace/status.json 形状增加 snapshot 摘要（结构键，不含事实列表）。
  const st = await bridge.status();
  assert.equal(st.ok, true);
  assert.equal(st.snapshot.sessionId, 'session-live2d');
  assert.equal(st.snapshot.situation, 'waiting_for_approval');
  assert.ok(st.snapshot.unavailableCount >= 1);
  assert.equal(JSON.stringify(st.snapshot).includes('用户原话'), false);
} finally {
  bridge.dispose();
  fs.rmSync(homeDir, { recursive: true, force: true });
}

// W1：快照回调抛错不能拖垮桥/通知链路，只让该段显示 unavailable。
const homeDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-workspace2-'));
const calls2 = [];
const workspace2 = { id: 'workspace-live2d-2', title: 'Live2D Agent', sessionIds: [] };
const ctx2 = {
  workspaceRegistry: { async create() { return workspace2; } },
  sessionController: {
    async create() {
      calls2.push(['create']);
      workspace2.sessionIds = ['session-live2d-2'];
      return { sessionId: 'session-live2d-2' };
    },
    async prompt(request) { calls2.push(['prompt', request]); return { accepted: true }; },
  },
};
const bridge2 = createWorkspaceAgentBridge({
  ctx: ctx2,
  homeDir: homeDir2,
  getSnapshot: async () => snapshot,
  getWorkspaceSnapshot: async () => {
    throw new Error('snapshot-broken');
  },
  intervalMs: 60000,
});
try {
  const r = await bridge2.ensure();
  assert.equal(r.ok, true);
  const promptText = calls2.find(([kind]) => kind === 'prompt')[1].content[0].text;
  assert.match(promptText, /【工作区快照】unavailable/);
  const st2 = await bridge2.status();
  assert.equal(st2.ok, true);
  assert.equal(st2.snapshot, null);
} finally {
  bridge2.dispose();
  fs.rmSync(homeDir2, { recursive: true, force: true });
}

// W1：buildNotifyPrompt 的 snapshotText 是可选段（旧调用方不传也能工作）。
console.log('workspace-agent: ok');
