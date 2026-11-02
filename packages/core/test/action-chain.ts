/**
 * 动作链优先级与 action-done 回执。
 * 运行：node --experimental-strip-types packages/core/test/action-chain.ts
 */
import assert from 'node:assert/strict';
import {
  ACT_PHASE_TEMPLATES,
  ActGate,
  actTemplateWritesMouth,
  canInterruptAct,
  closeMotionsOnPreempt,
  getActPhaseTemplate,
  parseActPriority,
  preemptedYandere,
} from '../src/index.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
};

console.log('\n动作链优先级\n');

test('缺省和无法识别的优先级都按 NORMAL', () => {
  assert.equal(parseActPriority(undefined), 'NORMAL');
  assert.equal(parseActPriority(''), 'NORMAL');
  assert.equal(parseActPriority('low'), 'NORMAL');
  assert.equal(parseActPriority('force'), 'FORCE');
  assert.equal(parseActPriority(' background '), 'BACKGROUND');
});

test('没有在播的链时，谁都可以开始', () => {
  assert.equal(canInterruptAct(null, 'BACKGROUND'), true);
});

test('低优先级不能打断高优先级，同级可以', () => {
  assert.equal(canInterruptAct('NORMAL', 'BACKGROUND'), false);
  assert.equal(canInterruptAct('FORCE', 'BACKGROUND'), false);
  assert.equal(canInterruptAct('FORCE', 'NORMAL'), false);
  assert.equal(canInterruptAct('NORMAL', 'NORMAL'), true);
  assert.equal(canInterruptAct('FORCE', 'FORCE'), true);
  assert.equal(canInterruptAct('BACKGROUND', 'NORMAL'), true);
  assert.equal(canInterruptAct('NORMAL', 'FORCE'), true);
});

test('被挡住时槽位不变，也不消耗 runId', () => {
  const gate = new ActGate();
  const first = gate.admit({ priority: 'FORCE', source: 'yandere', callId: 3, steps: 2 });
  assert.equal(first.accepted, true);
  const blocked = gate.admit({ priority: 'BACKGROUND', source: 'idle', callId: 4, steps: 1 });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, 'priority-blocked');
  assert.deepEqual(blocked.events, []);
  assert.equal(blocked.current && blocked.current.runId, first.runId);
  assert.equal(blocked.current && blocked.current.priority, 'FORCE');
  assert.equal(gate.current() && gate.current()?.runId, first.runId);
  const again = gate.admit({ priority: 'FORCE', source: 'dialogue', steps: 1 });
  assert.equal(again.runId, (first.runId || 0) + 1);
});

test('同级打断：旧链 interrupted，新链 start', () => {
  const gate = new ActGate();
  const first = gate.admit({ priority: 'NORMAL', source: 'ai', callId: 8, steps: 2 });
  const next = gate.admit({ priority: 'NORMAL', source: 'ai', callId: 9, steps: 1 });
  assert.equal(next.accepted, true);
  assert.equal(next.events.length, 2);
  assert.equal(next.events[0].type, 'action-done');
  assert.equal(next.events[0].phase, 'interrupted');
  assert.equal(next.events[0].reason, 'preempted');
  assert.equal(next.events[0].runId, first.runId);
  assert.equal(next.events[0].callId, 8);
  assert.equal(next.events[1].phase, 'start');
  assert.equal(next.events[1].runId, next.runId);
  assert.equal(next.events[1].callId, 9);
  assert.equal(next.events[1].priority, 'NORMAL');
  assert.equal(gate.finish(first.runId || 0), null);
});

test('播完只结束当前这条，结束后再挡住不了新的低优先级', () => {
  const gate = new ActGate();
  const first = gate.admit({ priority: 'FORCE', source: 'dialogue', steps: 3 });
  const end = gate.finish(first.runId || 0);
  assert.ok(end);
  assert.equal(end?.phase, 'end');
  assert.equal(end?.type, 'action-done');
  assert.equal(gate.current(), null);
  const idle = gate.admit({ priority: 'BACKGROUND', source: 'idle', steps: 1 });
  assert.equal(idle.accepted, true);
  assert.equal(idle.events.length, 1);
  assert.equal(idle.events[0].phase, 'start');
});

test('release 只撤指定的那条', () => {
  const gate = new ActGate();
  const held = gate.admit({ priority: 'FORCE', source: 'yandere', steps: 0 });
  assert.equal(gate.release(999, 'yandere-off'), null);
  assert.equal(gate.current()?.source, 'yandere');
  const ev = gate.release(held.runId || 0, 'yandere-off');
  assert.equal(ev?.phase, 'interrupted');
  assert.equal(ev?.reason, 'yandere-off');
  assert.equal(gate.current(), null);
});

test('四段短链都是 2～4 步，且不写口型', () => {
  const names = ['listening', 'thinking', 'speaking', 'settle'] as const;
  for (const name of names) {
    const template = getActPhaseTemplate(name);
    assert.ok(template);
    assert.equal(template?.id, name);
    assert.equal(ACT_PHASE_TEMPLATES[name], template);
    assert.ok(template.chain.length >= 2 && template.chain.length <= 4);
    assert.equal(actTemplateWritesMouth(template), false);
    for (const step of template.chain) {
      assert.ok(step.kind === 'expression' || step.kind === 'motion' || step.kind === 'pose' || step.kind === 'look');
    }
  }
  assert.equal(getActPhaseTemplate('listening')?.priority, 'FORCE');
  assert.equal(getActPhaseTemplate('speaking')?.priority, 'FORCE');
  assert.equal(getActPhaseTemplate('settle')?.priority, 'NORMAL');
  assert.equal(getActPhaseTemplate('nope'), null);
  const speaking = JSON.stringify(getActPhaseTemplate('speaking'));
  assert.equal(speaking.includes('ParamMouthOpenY'), false);
});

test('新链没有 motion 时，抢占要补播还挂着的关闭动作', () => {
  const listening = getActPhaseTemplate('listening');
  assert.ok(listening);
  assert.deepEqual(closeMotionsOnPreempt(['竖手指关闭'], listening.chain), ['竖手指关闭']);
  assert.deepEqual(
    closeMotionsOnPreempt(['竖手指关闭', '竖手指关闭', '抚胸手关闭'], [{ kind: 'expression' }, { kind: 'look' }]),
    ['竖手指关闭', '抚胸手关闭'],
  );
  assert.deepEqual(closeMotionsOnPreempt(['', '竖手指关闭'], [{ kind: 'pose' }]), ['竖手指关闭']);
});

test('新链带 motion 时不补播关闭动作，交给新动作覆盖', () => {
  const speaking = getActPhaseTemplate('speaking');
  assert.ok(speaking);
  assert.equal(
    speaking.chain.some((step) => step.kind === 'motion'),
    true,
  );
  assert.deepEqual(closeMotionsOnPreempt(['竖手指关闭'], speaking.chain), []);
  assert.deepEqual(
    closeMotionsOnPreempt(['竖手指关闭'], [{ kind: 'motion', name: '抚胸手打开' }]),
    [],
  );
  assert.deepEqual(closeMotionsOnPreempt([], [{ kind: 'look' }]), []);
});

test('只有邪神自己那条槽被抢走时才要收视觉层', () => {
  const held = { on: true, runId: 4 };
  assert.equal(preemptedYandere({ source: 'yandere', runId: 4 }, held), true);
  assert.equal(preemptedYandere({ source: 'dialogue', runId: 4 }, held), true);
  assert.equal(preemptedYandere({ source: 'poke', runId: 9 }, held), false);
  assert.equal(preemptedYandere({ source: 'yandere', runId: 4 }, { on: false, runId: 4 }), false);
  assert.equal(preemptedYandere(null, held), false);
});

if (process.exitCode) {
  console.error('\n动作链测试失败\n');
} else {
  console.log(`\n${passed} passed\n`);
}
