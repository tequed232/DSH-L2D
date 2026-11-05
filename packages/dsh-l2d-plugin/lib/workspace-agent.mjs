/**
 * dsh-l2d · 工作区专属 Agent 桥（L1 人设层改造版）
 *
 * 职责：把「其他 DSH 工作区的活动状态」变成一份脱敏的 agent.md + 结构化通知，
 * 推给专属 Live2D Agent（独立 workspace/session），由它用 l2d_choreograph 做反应。
 *
 * 与旧版的区别（L1）：
 *  1. 通知 prompt 里带人设（persona.mjs，每次读取，改完立即生效）；
 *  2. 带用户交互态（env-state.mjs；过期按 unknown，不用旧值误导）；
 *  3. 带每个工作区最近一次工具调用（真实回执：isError/error.code/退出码/超时/中断）
 *     与最后一次 turn/end 分类；
 *  4. 带上次动作回执摘要（l2d_* 工具结果），并提示 Agent 遵守 receipt 语义；
 *  5. 事件门控复用 choreography.mjs 的 decide()：优先级/去重/抖动/冷却/频次，
 *     外加本桥的最小通知间隔（30s）与「动作在途不打断」。
 *
 * 约束：只观察其他工作区，不读其文件/会话内容；只写自己的 agent.md 与 manifest。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { aggregateWorkspaceState, decide } from './choreography.mjs';
import { personaPromptBlock } from './persona.mjs';
import { envPromptBlock, readEnvState } from './env-state.mjs';
import { renderSnapshotContext, summarizeSnapshot } from './workspace-snapshot.mjs';

const marker = '<!-- managed-by: dsh-l2d-workspace-agent -->';
const instructions = [
  '# DSH-L2D Live2D Agent',
  '', marker, '',
  'You are the dedicated Live2D character agent for this DSH installation.',
  '所有回复、行为分析、角色台词必须使用简体中文（简体中文是唯一输出语言）。',
  'agent.md is the persisted redacted status snapshot (persona, user presence, other workspaces). State-change notifications include its current contents.',
  'Observe other DSH workspaces read-only. Never inspect their files or transcripts.',
  'Never prompt, steer, stop, archive, or modify another Session.',
  'Use the per-agent MCP tools by their registered names: mcp__dsh_l2d__l2d_choreograph, mcp__dsh_l2d__l2d_emote, mcp__dsh_l2d__l2d_act, mcp__dsh_l2d__l2d_say, mcp__dsh_l2d__l2d_gaze, mcp__dsh_l2d__l2d_get_state, mcp__dsh_l2d__l2d_reset, mcp__dsh_l2d__l2d_persona, mcp__dsh_l2d__l2d_workspace_status.',
  'Prefer l2d_choreograph: presetState for simple state reactions, segments for richer multi-stage performances. Max 15 segments, max 8 steps per segment.',
  'Treat MCP receipts as authoritative. accepted only means the slot was taken; action-done events are the real progress.',
  'Receipt semantics: conflict / priority-blocked wait at the queue head with bounded retries; accepted-but-pending must never be resubmitted (it would duplicate a running motion); interrupted / timeout keep the remaining queue and report the position.',
  'React subtly to thinking/working, acknowledge attention, show restrained concern for error, and settle to idle.',
  'While the user is typing (conversation) or away, stay quiet: no proactive performance.',
  'Prioritize direct user interaction over background reactions.', ''
].join('\n');

const NOTIFY_MIN_INTERVAL_MS = 30000;
const ACTION_STATES = new Set(['FORCE', 'NORMAL']);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp';
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (err) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function ensureInstructions(file) {
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (!current) writeAtomic(file, instructions);
}

function toolLine(session) {
  const last = session.lastTool;
  if (!last) return '最近工具调用：无';
  const code = last.code ? '（' + last.code + '）' : '';
  return '最近工具调用：' + (last.name || '?') + ' → ' + last.status + code;
}

/** 每个会话一行：状态 + 最近工具结果 + 最近 turn/end。 */
function renderSession(session) {
  const age = session.ageMs == null ? 'age unknown' : Math.round(session.ageMs / 1000) + 's since activity';
  const bits = [session.state || 'unknown', age, toolLine(session)];
  if (session.pendingAction) bits.push('动作回执未返回：' + session.pendingAction.name);
  if (session.lastTurnEnd) {
    const t = session.lastTurnEnd;
    bits.push('turn/end：' + t.kind + (t.code ? '（' + t.code + '）' : ''));
  }
  return '- ' + bits.join(' · ');
}

/** 脱敏状态快照（agent.md 正文）。 */
export function renderStatus(snapshot, ownId, persona, env) {
  const lines = ['# Live2D Agent — workspace status', '',
    '> Generated status only. Conversation content is intentionally excluded.',
    '', 'Updated: ' + (snapshot.generatedAt || new Date().toISOString()), ''];
  if (persona) {
    lines.push('## Persona', '', '```', personaPromptBlock(persona), '```', '');
  }
  if (env) {
    lines.push('## User presence', '', '```', envPromptBlock(env), '```', '');
  }
  const others = (snapshot.workspaces || []).filter((w) => String(w.workspaceId) !== String(ownId));
  if (!others.length) lines.push('No other registered workspaces are currently visible.');
  for (const w of others) {
    lines.push('## ' + (w.title || 'Untitled workspace'));
    if (!(w.sessions || []).length) lines.push('- No sessions');
    for (const s of (w.sessions || [])) lines.push(renderSession(s));
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

/** 上次动作回执摘要（只取 l2d_* 工具）。 */
export function renderActionReceipt(snapshot, ownId) {
  const receipts = [];
  for (const w of (snapshot.workspaces || [])) {
    if (String(w.workspaceId) === String(ownId)) continue;
    for (const s of (w.sessions || [])) {
      if (s.lastAction) receipts.push(s.lastAction);
    }
  }
  if (!receipts.length) return '【上次动作回执】无（最近没有 l2d_* 调用记录）';
  receipts.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
  const last = receipts[0];
  return '【上次动作回执】' + last.summary + (last.detail ? '（' + last.detail + '）' : '');
}

/** 通知 prompt。 */
export function buildNotifyPrompt({ status, persona, env, receipt, notifyState, userInput, snapshotText }) {
  return [
    '其他 DSH 工作区的活动状态发生变化（判定状态：' + notifyState + '）。以下是 agent.md 的最新内容：',
    '',
    status,
    '',
    persona ? personaPromptBlock(persona) : '【人设】（未加载）',
    '',
    env ? envPromptBlock(env) : '【用户交互态】unknown',
    '',
    receipt || '【上次动作回执】无',
    '',
    snapshotText || '【工作区快照】unavailable（未生成；不要据此猜测用户在做什么）',
    '',
    '规划要求：',
    '- 所有输出（行为分析、气泡台词）必须使用简体中文。',
    '- 所有表情、动作、气泡都要符合上述人设（性格关键词、情绪表达强度、主动程度、亲密程度、动作偏好）。',
    '- 用 mcp__dsh_l2d__l2d_choreograph：简单状态反应传 presetState，复杂编排传 segments（1~3 段，每段最多 8 步）。',
    '- 仅在未接纳（accepted=false）的 conflict / priority-blocked 回执上允许队列有限重试；accepted=true 的 pending 不得重复提交。interrupted/timeout 保留剩余队列并报告位置。',
    '- 用户正在输入或已离席时不要主动演出。',
    '- 如果判断不值得回应，只回一行结论，不要展开分析。',
    '- 不要联系或修改其他会话。',
  ].join('\n');
}

function fingerprint(snapshot, ownId, env, persona) {
  const workspaces = (snapshot.workspaces || [])
    .filter((w) => String(w.workspaceId) !== String(ownId))
    .map((w) => ({
      id: w.workspaceId,
      sessions: (w.sessions || []).map((s) => ({
        id: s.sessionIndex,
        state: s.state,
        error: s.hasError === true,
        tool: s.lastTool ? { name: s.lastTool.name, status: s.lastTool.status, code: s.lastTool.code } : null,
        turn: s.lastTurnEnd ? { kind: s.lastTurnEnd.kind, code: s.lastTurnEnd.code } : null,
      })),
    }));
  return JSON.stringify({
    workspaces,
    env: env && env.available ? { state: env.state, away: env.payload?.away === true, input: env.payload?.inputFocused === true } : { state: 'unknown' },
    persona: persona ? persona.updatedAt : null,
  });
}

/**
 * 判定一次通知该不该发（纯函数，便于单测）。
 * @param {object} input
 * @param {string} input.state 目标编排状态（error/attention/working/thinking/idle/user-direct）
 * @param {string} input.previousState
 * @param {number} input.stateSince 进入该状态的时间戳
 * @param {number[]} input.flips 最近状态翻转时间戳
 * @param {number} input.lastAnyFireAt
 * @param {Record<string, number>} input.lastFireAtByState
 * @param {Record<string, number[]>} input.firesByState
 * @param {object|null} input.env
 * @param {number} [input.now]
 * @returns {{fire: boolean, reason: string, retryAfterMs?: number, decision?: object}}
 */
export function decideNotification(input) {
  const now = Number(input.now) || Date.now();
  const state = String(input.state || 'idle');
  const env = input.env || null;
  const isError = state === 'error';

  if (env && env.available) {
    const away = env.payload && env.payload.away === true;
    const inputting = env.state === 'conversation';
    // 用户输入中 / 离席：不主动演出（error 例外——出事要让人看见）。
    if (!isError && (away || inputting)) {
      return { fire: false, reason: away ? 'user-away' : 'user-input' };
    }
  }

  const decision = decide({
    state,
    previousState: input.previousState,
    stateSince: input.stateSince,
    flips: input.flips,
    lastAnyFireAt: input.lastAnyFireAt,
    lastFireAtByState: input.lastFireAtByState,
    firesByState: input.firesByState,
    now,
    ...(input.force === true ? { force: true } : {}),
  });

  if (!decision.fire) return { fire: false, reason: decision.reason, retryAfterMs: decision.retryAfterMs, decision };

  // 桥的最小通知间隔：30s 内不重复（error 例外）。
  const sinceLastNotify = now - (Number(input.lastNotifyAt) || 0);
  const minInterval = Number(input.notifyMinIntervalMs) || NOTIFY_MIN_INTERVAL_MS;
  if (!isError && sinceLastNotify < minInterval) {
    return { fire: false, reason: 'notify-cooldown', retryAfterMs: minInterval - sinceLastNotify, decision };
  }
  return { fire: true, reason: 'fire', decision };
}

/** 是否有动作工具在途（在途时本轮不通知，等回执）。 */
export function hasPendingAction(snapshot) {
  for (const w of (snapshot.workspaces || [])) {
    for (const s of (w.sessions || [])) {
      if (s.pendingAction && ACTION_STATES.has(s.pendingAction.priority || 'NORMAL')) return true;
    }
  }
  return false;
}

/**
 * @param {object} options
 * @param {object} options.ctx cordis 上下文（workspaceRegistry / sessionController）
 * @param {string} [options.homeDir]
 * @param {() => Promise<object>|object} options.getSnapshot 返回 {workspaces:[...]}
 * @param {() => object} [options.getPersona] 人设读取（默认读 persona 文件）
 * @param {number} [options.intervalMs]
 * @param {number} [options.notifyMinIntervalMs]
 */
export function createWorkspaceAgentBridge({ ctx, homeDir = path.join(os.homedir(), '.dsh'), getSnapshot, getPersona, getWorkspaceSnapshot, intervalMs = 4000, notifyMinIntervalMs = NOTIFY_MIN_INTERVAL_MS }) {
  const directory = path.join(homeDir, 'workspaces', 'live2d-agent');
  const manifestPath = path.join(homeDir, 'l2d-workspace-agent.json');
  let workspace = null;
  let sessionId = null;
  let latest = { ok: true, generatedAt: new Date().toISOString(), workspaces: [] };
  let latestSnapshot = null;
  let timer = null;
  let refreshing = false;
  let pendingEnsure = null;

  const gate = {
    state: null,
    previousState: null,
    stateSince: 0,
    flips: [],
    lastAnyFireAt: 0,
    lastFireAtByState: {},
    firesByState: {},
    lastNotifyAt: 0,
    lastFingerprint: '',
    lastStatusText: '',
    lastEnv: null,
    lastReason: '',
  };

  const registry = ctx.workspaceRegistry || ctx.get?.('workspaceRegistry');
  const controller = ctx.sessionController || ctx.get?.('sessionController');

  function readPersonaSafe() {
    try {
      return typeof getPersona === 'function' ? getPersona() : null;
    } catch {
      return null;
    }
  }

  function readEnvSafe() {
    try {
      return readEnvState({ homeDir });
    } catch {
      return { available: false, stale: false, ageMs: null, state: 'unknown', payload: null, reason: 'unreadable' };
    }
  }

  async function prompt(text, requestId = randomUUID()) {
    await controller.prompt({
      requestId, sessionId, mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal);
  }

  /** 判定目标状态：error > away-return(user-direct) > 聚合状态。 */
  function pickNotifyState(snapshot, env) {
    const aggregate = aggregateWorkspaceState(snapshot, workspace ? workspace.id : undefined);
    const hasError = aggregate.state === 'error';
    const returned = env && env.available && gate.lastEnv
      && gate.lastEnv.available
      && gate.lastEnv.payload && gate.lastEnv.payload.away === true
      && env.payload && env.payload.away === false;
    if (hasError) return { state: 'error', why: 'aggregate-error' };
    if (returned) return { state: 'user-direct', why: 'away-return' };
    return { state: aggregate.state, why: 'aggregate' };
  }

  async function refresh(notify = true) {
    if (!workspace || refreshing || typeof getSnapshot !== 'function') return latest;
    refreshing = true;
    try {
      const snapshot = (await getSnapshot()) || latest;
      latest = snapshot;
      const env = readEnvSafe();
      const persona = readPersonaSafe();
      // W1：结构化工作区快照 → 规划 prompt 的「事实 / 推断 / 不可得」三段。
      // 取不到快照只影响这一段（按 unavailable 渲染），不阻塞通知链路。
      let wsSnapshot = null;
      try {
        wsSnapshot = typeof getWorkspaceSnapshot === 'function' ? await getWorkspaceSnapshot() : null;
      } catch {
        wsSnapshot = null;
      }
      latestSnapshot = wsSnapshot;
      const snapshotText = wsSnapshot ? renderSnapshotContext(wsSnapshot) : '';
      const status = renderStatus(snapshot, workspace.id, persona, env);
      // 内容未变则跳过写盘：每 4s 一次 tmp+rename 的磁盘 churn 不值得。
      if (status !== gate.lastStatusText) {
        writeAtomic(path.join(directory, 'agent.md'), status);
        gate.lastStatusText = status;
      }

      const nextFingerprint = fingerprint(snapshot, workspace.id, env, persona);
      const changed = nextFingerprint !== gate.lastFingerprint;
      gate.lastFingerprint = nextFingerprint;

      const now = Date.now();
      const picked = pickNotifyState(snapshot, env);
      if (picked.state !== gate.state) {
        if (gate.state !== null) {
          gate.previousState = gate.state;
          gate.flips.push(now);
          const cutoff = now - 20000;
          gate.flips = gate.flips.filter((at) => at >= cutoff);
        }
        gate.state = picked.state;
        gate.stateSince = now;
      }

      let result = { fire: false, reason: 'no-change' };
      if (notify && (changed || picked.state !== gate.previousState)) {
        result = decideNotification({
          state: picked.state,
          previousState: gate.previousState,
          stateSince: gate.stateSince,
          flips: gate.flips,
          lastAnyFireAt: gate.lastAnyFireAt,
          lastFireAtByState: gate.lastFireAtByState,
          firesByState: gate.firesByState,
          env,
          now,
          lastNotifyAt: gate.lastNotifyAt,
          notifyMinIntervalMs,
        });
        if (result.fire && hasPendingAction(snapshot)) {
          result = { fire: false, reason: 'action-pending' };
        }
      }
      // 决定轮结束后把当前状态固化为 previousState：
      // 否则稳态期间 previousState 恒 ≠ picked.state，decide() 的 same-state/refreshMs
      // 抑制永不生效（working 的 25s 刷新脉冲会被退化成 cooldown+rate 兜底）。
      gate.previousState = picked.state;

      if (result.fire) {
        const text = buildNotifyPrompt({
          status,
          persona,
          env,
          receipt: renderActionReceipt(snapshot, workspace.id),
          notifyState: picked.state,
          userInput: !!(env && env.available && env.state === 'conversation'),
          snapshotText,
        });
        // 发送失败不消耗频次预算：否则 controller 持续故障时 lastNotifyAt/firesByState
        // 照记，真实通知反而被 rate/cooldown 拦死。
        let sent = true;
        try {
          await prompt(text);
        } catch {
          sent = false;
        }
        if (sent) {
          gate.lastAnyFireAt = now;
          gate.lastNotifyAt = now;
          (gate.firesByState[picked.state] = gate.firesByState[picked.state] || []).push(now);
          gate.lastFireAtByState[picked.state] = now;
        } else {
          result = { fire: false, reason: 'notify-send-failed' };
        }
      }
      gate.lastReason = result.reason;
      gate.lastEnv = env;
      return { ...latest, notify: { fired: result.fire, reason: result.reason, state: picked.state, why: picked.why } };
    } finally {
      refreshing = false;
    }
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
      let presetUsed = null;
      if (!sessionId) {
        // 专属预设是可选的：基线里没有注册 dsh-l2d 预设时退回普通会话，桥仍可工作。
        try {
          const value = await controller.create({ workspaceId: workspace.id, agentPreset: 'dsh-l2d' });
          sessionId = value.sessionId;
          presetUsed = 'dsh-l2d';
        } catch {
          const value = await controller.create({ workspaceId: workspace.id });
          sessionId = value.sessionId;
          presetUsed = null;
        }
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
        const env = readEnvSafe();
        const persona = readPersonaSafe();
        const snapshotText = latestSnapshot ? renderSnapshotContext(latestSnapshot) : '【工作区快照】unavailable（未生成）';
        await prompt(
          '初始化你的 Live2D 专属工作区。你的 AGENTS.md 指令已由 DSH Agent Instructions 加载。你是独立桌宠 Agent；所有输出（行为分析、气泡台词）必须使用简体中文。' +
            '以下是当前状态快照：\n\n' + renderStatus(latest, workspace.id, persona, env) +
            '\n\n' + (persona ? personaPromptBlock(persona) : '') +
            '\n\n' + snapshotText +
            '\n\n不要读取其他工作区文件或聊天记录。用 mcp__dsh_l2d__l2d_choreograph 的 presetState=bootstrap 做一次简短的登场，并用 mcp__dsh_l2d__l2d_get_state 确认角色就绪。',
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
    return {
      ok: true,
      workspace: { workspaceId: workspace.id, title: workspace.title, sessionId },
      generatedAt: latest.generatedAt,
      workspaces: latest.workspaces,
      // 快照摘要（只给结构键；完整快照在 /dsh-l2d/workspace/snapshot.json）。
      snapshot: summarizeSnapshot(latestSnapshot),
    };
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { ensure, status, refresh, dispose };
}
