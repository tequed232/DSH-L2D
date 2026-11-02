import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const marker = '<!-- managed-by: dsh-l2d-workspace-agent -->';
const instructions = [
  '# DSH-L2D Live2D Agent', '', marker, '',
  'You are the dedicated Live2D character agent for this DSH installation.',
  'Read agent.md for the latest redacted workspace activity snapshot.',
  'Observe other DSH workspaces read-only. Never inspect their files or transcripts.',
  'Never prompt, steer, stop, archive, or modify another Session.',
  'When the DSH MCP serverName is dsh_l2d, call tools by their registered names: mcp__dsh_l2d__l2d_emote, mcp__dsh_l2d__l2d_act, mcp__dsh_l2d__l2d_say, mcp__dsh_l2d__l2d_gaze, mcp__dsh_l2d__l2d_get_state, and mcp__dsh_l2d__l2d_reset.',
  'Treat MCP receipts as authoritative. Never claim an action completed without a successful receipt.',
  'React subtly to thinking/working, acknowledge attention, show restrained concern for error, and settle to idle.',
  'Prioritize direct user interaction over background reactions.', ''
].join('\n');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}
function ensureInstructions(file) {
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch {}
  if (!current) writeAtomic(file, instructions);
}
function renderStatus(snapshot, ownId) {
  const lines = ['# Live2D Agent — workspace status', '',
    '> Generated status only. Conversation content is intentionally excluded.',
    '', 'Updated: ' + (snapshot.generatedAt || new Date().toISOString()), ''];
  const others = (snapshot.workspaces || []).filter((w) => String(w.workspaceId) !== String(ownId));
  if (!others.length) lines.push('No other registered workspaces are currently visible.');
  for (const w of others) {
    lines.push('## ' + (w.title || 'Untitled workspace'));
    if (!(w.sessions || []).length) lines.push('- No sessions');
    for (const s of (w.sessions || [])) {
      const age = s.ageMs == null ? 'age unknown' : Math.round(s.ageMs / 1000) + 's since activity';
      lines.push('- ' + (s.state || 'unknown') + ' · ' + age);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
function fingerprint(snapshot, ownId) {
  return JSON.stringify((snapshot.workspaces || [])
    .filter((w) => String(w.workspaceId) !== String(ownId))
    .map((w) => ({ id: w.workspaceId, sessions: (w.sessions || []).map((s) => ({
      id: s.sessionIndex, state: s.state, error: s.hasError === true
    })) })));
}

export function createWorkspaceAgentBridge({ ctx, homeDir = path.join(os.homedir(), '.dsh'), getSnapshot, intervalMs = 4000 }) {
  const directory = path.join(homeDir, 'workspaces', 'live2d-agent');
  const manifestPath = path.join(homeDir, 'l2d-workspace-agent.json');
  let workspace = null;
  let sessionId = null;
  let latest = { ok: true, generatedAt: new Date().toISOString(), workspaces: [] };
  let lastFingerprint = '';
  let timer = null;
  let pendingEnsure = null;
  let refreshing = false;
  const registry = ctx.workspaceRegistry || ctx.get?.('workspaceRegistry');
  const controller = ctx.sessionController || ctx.get?.('sessionController');

  async function prompt(text, requestId = randomUUID()) {
    await controller.prompt({
      requestId, sessionId, mode: 'queue',
      content: [{ type: 'text', text }]
    }, new AbortController().signal);
  }

  async function refresh(notify = true) {
    if (!workspace || refreshing || typeof getSnapshot !== 'function') return latest;
    refreshing = true;
    try {
      latest = await getSnapshot() || latest;
      writeAtomic(path.join(directory, 'agent.md'), renderStatus(latest, workspace.id));
      const next = fingerprint(latest, workspace.id);
      if (notify && lastFingerprint && next !== lastFingerprint) {
        await prompt('其他 DSH 工作区的活动状态发生变化。请读取 agent.md，判断是否需要一次克制、自然的 Live2D 反馈。只观察，不联系或修改其他会话。').catch(() => {});
      }
      lastFingerprint = next;
      return latest;
    } finally { refreshing = false; }
  }

  function start() {
    if (timer || typeof getSnapshot !== 'function') return;
    timer = setInterval(() => { void refresh().catch(() => {}); }, Math.max(1500, intervalMs));
    timer.unref?.();
  }

  async function ensure() {
    if (pendingEnsure) return pendingEnsure;
    pendingEnsure = (async () => {
      if (!registry?.create || !controller?.create || !controller?.prompt) {
        return { ok: false, reason: 'dsh-workspace-services-unavailable' };
      }
      fs.mkdirSync(directory, { recursive: true });
      ensureInstructions(path.join(directory, 'AGENTS.md'));
      workspace = await registry.create(directory, 'Live2D Agent');
      const manifest = readJson(manifestPath);
      const matches = manifest?.workspaceId === workspace.id;
      const archived = new Set(registry.archivedSessionIds || []);
      sessionId = matches && workspace.sessionIds.includes(manifest.sessionId) && !archived.has(manifest.sessionId)
        ? manifest.sessionId
        : (workspace.sessionIds.find((id) => !archived.has(id)) || null);
      const sameSession = matches && manifest?.sessionId === sessionId;
      let created = false;
      if (!sessionId) {
        const value = await controller.create({ workspaceId: workspace.id });
        sessionId = value.sessionId;
        created = true;
      }
      const bootstrapRequestId = sameSession && manifest?.bootstrapRequestId
        ? manifest.bootstrapRequestId : randomUUID();
      const nextManifest = {
        version: 1, workspaceId: workspace.id, sessionId, workspacePath: directory,
        bootstrapRequestId,
        bootstrapSent: sameSession && manifest?.bootstrapSent === true,
        updatedAt: new Date().toISOString()
      };
      writeAtomic(manifestPath, JSON.stringify(nextManifest, null, 2) + '\n');
      await refresh(false);
      if (!nextManifest.bootstrapSent) {
        await prompt(
          '初始化你的 Live2D 专属工作区。先阅读 AGENTS.md 和 agent.md。你是独立桌宠 Agent；后续会收到其他工作区的状态变化。不要读取其他工作区文件或聊天记录。若 dsh-l2d MCP 工具可用，调用 l2d_get_state 检查角色并简短确认就绪。',
          bootstrapRequestId
        );
        nextManifest.bootstrapSent = true;
        nextManifest.updatedAt = new Date().toISOString();
        writeAtomic(manifestPath, JSON.stringify(nextManifest, null, 2) + '\n');
      }
      start();
      return { ok: true, created, workspaceId: workspace.id, workspacePath: directory, sessionId, title: workspace.title };
    })().finally(() => { pendingEnsure = null; });
    return pendingEnsure;
  }

  async function status() {
    if (!workspace) {
      const ready = await ensure();
      if (!ready.ok) return ready;
    }
    await refresh();
    return { ok: true, workspace: { workspaceId: workspace.id, title: workspace.title, sessionId }, generatedAt: latest.generatedAt, workspaces: latest.workspaces };
  }
  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  return { ensure, status, refresh, dispose };
}
