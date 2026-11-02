import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceAgentBridge } from './workspace-agent.mjs';

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
const bridge = createWorkspaceAgentBridge({ ctx, homeDir, getSnapshot: async () => snapshot, intervalMs: 60000 });
try {
  const result = await bridge.ensure();
  assert.equal(result.ok, true);
  assert.equal(result.workspaceId, 'workspace-live2d');
  assert.equal(result.sessionId, 'session-live2d');
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'prompt').length, 1);
  const instructions = fs.readFileSync(path.join(result.workspacePath, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /Live2D character agent/);
  const status = fs.readFileSync(path.join(result.workspacePath, 'agent.md'), 'utf8');
  assert.match(status, /Other project/);
  assert.match(status, /working/);
  const again = await bridge.ensure();
  assert.equal(again.sessionId, 'session-live2d');
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal((await bridge.status()).ok, true);
} finally {
  bridge.dispose();
  fs.rmSync(homeDir, { recursive: true, force: true });
}
console.log('workspace-agent: ok');
