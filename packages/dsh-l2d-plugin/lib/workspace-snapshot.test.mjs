import assert from 'node:assert/strict';
import {
  RELIABILITY,
  SNAPSHOT_SCHEMA_VERSION,
  UNAVAILABLE_REASON,
  buildWorkspaceContextSnapshot,
  processNameOnly,
  redactSensitive,
} from './workspace-snapshot.mjs';
import { summarizeSession } from './session-events.mjs';

const t0 = 1793700000000;
const iso = (ms) => new Date(ms).toISOString();
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// 构造会话事实（与 summarizeSession 真实输出同形状，不读真实会话）。
const summary = summarizeSession(
  [
    { type: 'user/message', time: t0, data: { content: [{ type: 'text', text: '把这个修一下' }] } },
    { type: 'tool/call', time: t0 + 10, data: { callId: 'c1', name: 'bash' } },
    { type: 'approval/asked', time: t0 + 20, data: { id: 'ap1', toolName: 'bash', callId: 'c1', reason: 'token=abc /d/secret' } },
    { type: 'job/registered', time: t0 + 30, data: { jobId: 'j1', owner: 's', kind: 'bash', label: 'rm -rf /secret path', startedAt: t0 + 30 } },
    { type: 'command/run', time: t0 + 40, data: { commandId: 'cm1', name: 'plan', args: '', source: {} } },
    { type: 'todo/write', time: t0 + 50, data: { todos: [{}, {}] } },
    { type: 'goal/change', time: t0 + 60, data: { kind: 'goal', operation: 'updated', roundsStarted: 1, version: 2, updatedAt: t0 + 60 } },
    { type: 'workspace/changes', time: t0 + 70, data: { turn: 3 } },
    { type: 'deliverables/presented', time: t0 + 80, data: { turn: 3, callId: 'd1', files: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] } },
  ],
  { now: t0 + 90 },
);
const presence = {
  available: true,
  stale: false,
  ageMs: 1200,
  state: 'work',
  payload: { state: 'work', away: false, idleMs: 2400, hidden: false, inputFocused: false, lastTypingAt: t0 },
};
const activity = {
  situation: 'waiting_for_approval',
  confidence: 0.95,
  evidence: ['summary.approvals.pending=1', 'presence.state=work'],
};
const foreground = { ok: true, name: 'C:\\Program Files\\Microsoft VS Code\\Code.exe', at: t0 + 50 };

const snapshot = buildWorkspaceContextSnapshot({
  sessionId: 'session-1',
  summary,
  presence,
  foreground,
  activity,
  now: t0 + 100,
});

// 1) 顶层结构 / 时间格式 / 版本。
assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
assert.equal(snapshot.sessionId, 'session-1');
assert.equal(snapshot.timestamp, iso(t0 + 100));
assert.match(snapshot.timestamp, ISO_RE);
assert.equal(snapshot.staleMs, 20); // 快照时刻 t0+100 − 最近事件 t0+80

// 2) 事实进入 observed，且与 section 值一致。
const fact = (path) => snapshot.observed.find((item) => item.path === path);
assert.deepEqual(fact('sessionId'), { path: 'sessionId', value: 'session-1', source: 'host' });
assert.deepEqual(fact('presence.state'), { path: 'presence.state', value: 'work', source: 'presence-file' });
assert.equal(fact('presence.inputFocused').value, false);
assert.equal(fact('presence.userActive').value, true);
assert.equal(fact('presence.idleMs').value, 2400);
assert.equal(fact('approval.pending').value, 1);
assert.equal(fact('jobs.running').value, 1);
assert.equal(fact('jobs.failed').value, 0);
assert.equal(fact('todos.count').value, 2);
assert.equal(fact('goals.roundsStarted').value, 1);
assert.equal(fact('changedFiles.turn').value, 3);
assert.equal(fact('deliverables.count').value, 3);
assert.equal(fact('foregroundProcess.name').value, 'Code.exe');
assert.equal(fact('foregroundProcess.name').source, 'foreground-collector');

// 3) 段落值（消费方直接读的部分）。
assert.deepEqual(snapshot.presence, {
  state: 'work',
  inputFocused: false,
  userActive: true,
  idleMs: 2400,
  ageMs: 1200,
});
assert.deepEqual(snapshot.approval.pending, 1);
assert.deepEqual(snapshot.approval.items, [{ toolName: 'bash' }]);
assert.deepEqual(snapshot.jobs.items[0].kind, 'bash');
assert.equal(snapshot.commands.running, true);
assert.deepEqual(snapshot.commands.last, { name: 'plan', doneKind: null });
assert.equal(snapshot.todos.count, 2);
assert.equal(snapshot.todos.updatedAt, iso(t0 + 50));
assert.equal(snapshot.goals.lastOperation, 'updated');
assert.equal(snapshot.changedFiles.turn, 3);
assert.equal(snapshot.changedFiles.fileCount, null);
assert.equal(snapshot.deliverables.count, 3);
assert.equal(snapshot.foregroundProcess.name, 'Code.exe');
assert.equal(snapshot.foregroundProcess.observedAt, iso(t0 + 50));

// 4) 推断进 inferred，带 confidence + evidence；不得进 observed。
assert.equal(snapshot.activity.situation, 'waiting_for_approval');
assert.equal(snapshot.activity.confidence, 0.95);
const inference = snapshot.inferred.find((item) => item.path === 'activity.situation');
assert.ok(inference);
assert.equal(inference.value, 'waiting_for_approval');
assert.equal(inference.confidence, 0.95);
assert.deepEqual(inference.evidence, ['summary.approvals.pending=1', 'presence.state=work']);
assert.equal(snapshot.observed.some((item) => item.path === 'activity.situation'), false);

// 5) unavailable 明确列出（W1 未接线的 changedFiles.fileCount 必须在）。
assert.ok(snapshot.unavailable.some((item) => item.path === 'changedFiles.fileCount' && item.reason === UNAVAILABLE_REASON.NOT_WIRED));

// 6) 敏感信息过滤：job label / approval reason / 用户文本不得出现在快照里；
//    foreground 只留 basename，不含路径。
const json = JSON.stringify(snapshot);
assert.equal(json.includes('rm -rf /secret path'), false);
assert.equal(json.includes('token=abc'), false);
assert.equal(json.includes('/d/secret'), false);
assert.equal(json.includes('把这个修一下'), false);
assert.equal(json.includes('C:\\Program Files'), false);
assert.equal(json.includes('“'), false);

// 7) 所有时间字段都是 ISO（UTC, 毫秒）。
const collectStrings = (node, out = []) => {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((item) => collectStrings(item, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((item) => collectStrings(item, out));
  return out;
};
for (const value of collectStrings(snapshot)) {
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) assert.match(value, ISO_RE, '时间字段必须统一 UTC ISO-8601: ' + value);
}

// 8) 缺失字段不伪装：没有会话就没有 session 段落，全部 null + unavailable，
//    绝不给 idle/success 默认值。
const empty = buildWorkspaceContextSnapshot({ now: t0 });
assert.equal(empty.sessionId, null);
assert.equal(empty.presence, null);
assert.equal(empty.activity, null);
assert.equal(empty.approval, null);
assert.equal(empty.jobs, null);
assert.equal(empty.commands, null);
assert.equal(empty.todos, null);
assert.equal(empty.goals, null);
assert.equal(empty.changedFiles, null);
assert.equal(empty.deliverables, null);
assert.equal(empty.foregroundProcess, null);
assert.equal(empty.staleMs, null);
assert.ok(empty.unavailable.some((item) => item.path === 'sessionId' && item.reason === UNAVAILABLE_REASON.NO_SESSION));
assert.ok(empty.unavailable.some((item) => item.path === 'presence'));
assert.ok(empty.unavailable.some((item) => item.path === 'activity' && item.reason === UNAVAILABLE_REASON.ANALYZER_UNAVAILABLE));
assert.equal(empty.observed.length, 0);
assert.equal(empty.inferred.length, 0);

// 9) presence 过期/缺失 → 明确 unavailable，不落 state=unknown 到段落里。
const stale = buildWorkspaceContextSnapshot({
  sessionId: 's',
  summary,
  presence: { available: false, stale: true, ageMs: 99999, state: 'unknown', payload: null, reason: 'stale' },
  now: t0,
});
assert.equal(stale.presence, null);
assert.ok(stale.unavailable.some((item) => item.path === 'presence' && item.reason === UNAVAILABLE_REASON.STALE));

// 10) foreground：关闭 → disabled；采集失败 → collector-failed；标题类字段一律忽略。
const disabled = buildWorkspaceContextSnapshot({ sessionId: 's', foreground: { ok: false, reason: 'disabled' }, now: t0 });
assert.equal(disabled.foregroundProcess, null);
assert.ok(disabled.unavailable.some((item) => item.path === 'foregroundProcess' && item.reason === UNAVAILABLE_REASON.DISABLED));
const failed = buildWorkspaceContextSnapshot({ sessionId: 's', foreground: { ok: false, reason: 'koffi-unavailable' }, now: t0 });
assert.ok(failed.unavailable.some((item) => item.path === 'foregroundProcess' && item.reason === UNAVAILABLE_REASON.COLLECTOR_FAILED));
const withTitle = buildWorkspaceContextSnapshot({
  sessionId: 's',
  foreground: { ok: true, name: 'Code.exe', at: t0, title: 'secret.txt - workspace - VS Code' },
  now: t0,
});
assert.equal(withTitle.foregroundProcess.name, 'Code.exe');
assert.equal(JSON.stringify(withTitle).includes('secret.txt'), false);

// 11) 脱敏规则单测：常见凭据形状。
assert.equal(redactSensitive('sk-abcdefgh12345678'), '[redacted]');
assert.equal(redactSensitive('token=abcDEF123'), '[redacted]');
assert.equal(redactSensitive('Bearer eyJhbGciOi.abcdefgh.ijklmnop'), '[redacted]');
const urlRedacted = redactSensitive('https://x/?api_key=abc&y=1');
assert.equal(urlRedacted.includes('abc'), false); // 值必须消失
assert.equal(urlRedacted.includes('y=1'), true); // 不相关的参数保留
assert.equal(redactSensitive('ghp_abcdefghijklmnopqrst'), '[redacted]');
assert.equal(redactSensitive('普通文字'), '普通文字');
assert.equal(redactSensitive('x'.repeat(200)).length, 121); // 120 + 省略号
assert.equal(processNameOnly('/usr/bin/node'), 'node');
assert.equal(processNameOnly('C:\\x\\Code.exe'), 'Code.exe');
assert.equal(processNameOnly(null), '');

// 12) 显式 unavailable 透传 + 确定性输出。
const extra = buildWorkspaceContextSnapshot({
  sessionId: 's',
  summary,
  now: t0,
  unavailable: [{ path: 'browser', reason: UNAVAILABLE_REASON.DISABLED }],
});
assert.ok(extra.unavailable.some((item) => item.path === 'browser'));
const again = buildWorkspaceContextSnapshot({
  sessionId: 's',
  summary,
  now: t0,
  unavailable: [{ path: 'browser', reason: UNAVAILABLE_REASON.DISABLED }],
});
assert.deepEqual(extra, again);

// 13) reliability 常量三态齐全（消费方按它分支）。
assert.deepEqual(RELIABILITY, { OBSERVED: 'observed', INFERRED: 'inferred', UNAVAILABLE: 'unavailable' });

console.log('workspace-snapshot ok');
