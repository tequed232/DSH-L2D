/**
 * 邪神常驻、按手收招、动作被拒时回执带 reason。
 * 跑的是 overlay 自己的开场 / 戳一下 / 菜单关闭，断言暗角、黑脸和动作槽。
 * 运行：node --experimental-strip-types packages/dsh-l2d-plugin/lib/yandere-preempt.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ActGate, getActPhaseTemplate, motionResultKind } from '../../core/src/index.ts';
import { closeMotionsOnPreempt, preemptedYandere } from '../../core/src/action-chain.ts';
import { MotionDirector, motionsShareArm } from '../../renderer/src/app/motion-director.ts';

const here = dirname(fileURLToPath(import.meta.url));

class ClassList {
  constructor() {
    this._set = new Set();
  }
  add(...names) {
    for (const name of names) if (name) this._set.add(name);
  }
  remove(...names) {
    for (const name of names) this._set.delete(name);
  }
  contains(name) {
    return this._set.has(name);
  }
  replaceFrom(value) {
    this._set = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }
}

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this.classList = new ClassList();
    this.id = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.type = '';
    this.draggable = false;
    this.offsetWidth = 320;
    this.offsetHeight = 400;
    this.naturalWidth = 8;
    this.naturalHeight = 8;
  }
  set className(value) {
    this.classList.replaceFrom(value);
  }
  get className() {
    return [...this.classList._set].join(' ');
  }
  set innerHTML(_value) {
    this.children.length = 0;
  }
  get innerHTML() {
    return '';
  }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'id') this.id = String(value);
  }
  getAttribute(key) {
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }
  appendChild(child) {
    if (child.parentNode && child.parentNode.children) {
      const old = child.parentNode.children;
      const at = old.indexOf(child);
      if (at >= 0) old.splice(at, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }
  removeEventListener() {}
  contains(node) {
    if (node === this) return true;
    for (const child of this.children) {
      if (child.contains && child.contains(node)) return true;
    }
    return false;
  }
  querySelector(sel) {
    return queryAll(this, sel)[0] || null;
  }
  querySelectorAll(sel) {
    return queryAll(this, sel);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 320, bottom: 400, width: 320, height: 400 };
  }
  getContext() {
    return {};
  }
}

function matches(el, sel) {
  if (!sel) return false;
  if (sel.startsWith('.')) return !!(el.classList && el.classList.contains(sel.slice(1)));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  return String(el.tagName || '').toUpperCase() === sel.toUpperCase();
}

function queryAll(root, sel) {
  const parts = String(sel || '').split(',').map((item) => item.trim()).filter(Boolean);
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (parts.some((part) => matches(child, part))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function walkElements(node, visit) {
  visit(node);
  for (const child of node.children || []) walkElements(child, visit);
}

const head = new El('head');
const body = new El('body');
const docListeners = {};
const document = {
  readyState: 'loading',
  head,
  body,
  documentElement: new El('html'),
  createElement(tag) {
    return new El(tag);
  },
  getElementsByTagName(tag) {
    const want = String(tag || '').toLowerCase();
    const out = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (String(child.tagName || '').toLowerCase() === want) out.push(child);
        walk(child);
      }
    };
    walk(document.head);
    walk(document.body);
    return out;
  },
  getElementById(id) {
    let found = null;
    walkElements(body, (el) => {
      if (!found && el.id === id) found = el;
    });
    walkElements(head, (el) => {
      if (!found && el.id === id) found = el;
    });
    return found;
  },
  addEventListener(type, fn) {
    if (!docListeners[type]) docListeners[type] = [];
    docListeners[type].push(fn);
  },
  removeEventListener(type, fn) {
    const list = docListeners[type] || [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  },
  querySelector(sel) {
    return queryAll(body, sel)[0] || queryAll(head, sel)[0] || null;
  },
  querySelectorAll(sel) {
    return queryAll(body, sel).concat(queryAll(head, sel));
  },
};

const store = new Map();
const localStorage = {
  getItem(key) {
    return store.has(key) ? store.get(key) : null;
  },
  setItem(key, value) {
    store.set(key, String(value));
  },
  removeItem(key) {
    store.delete(key);
  },
};

const timers = [];
let clock = 0;
let timerSeq = 1;

function setTimeout(fn, ms) {
  const id = timerSeq++;
  timers.push({ id, fn, at: clock + (Number(ms) || 0), interval: false });
  return id;
}
function setInterval(fn, ms) {
  const id = timerSeq++;
  timers.push({ id, fn, at: clock + (Number(ms) || 0), interval: true, ms: Number(ms) || 0 });
  return id;
}
function clearTimer(id) {
  const at = timers.findIndex((item) => item.id === id);
  if (at >= 0) timers.splice(at, 1);
}
function flushTimers(ms) {
  const end = clock + ms;
  for (;;) {
    let nextIndex = -1;
    for (let i = 0; i < timers.length; i++) {
      if (timers[i].at > end) continue;
      if (nextIndex < 0 || timers[i].at < timers[nextIndex].at) nextIndex = i;
    }
    if (nextIndex < 0) break;
    const next = timers[nextIndex];
    timers.splice(nextIndex, 1);
    clock = next.at;
    if (next.interval) {
      next.at = clock + next.ms;
      timers.push(next);
    }
    next.fn();
  }
  clock = end;
}

const events = [];
const played = [];
const director = new MotionDirector();
const gate = new ActGate();
const state = { expression: null };
let busy = false;
let generation = 0;

function releaseMotion() {
  generation += 1;
  busy = false;
}

function playMotionAsync(group, opts = {}) {
  const decision = director.decide(group);
  const force = !!(opts && (opts.interrupt || opts.priority === 3));
  if (decision.status === 'skipped' || decision.status === 'conflict') {
    played.push({ group, opts, status: decision.status, reason: decision.reason });
    return Promise.resolve({
      status: decision.status,
      reason: decision.reason,
      slot: decision.slot,
      dir: decision.dir,
      group: decision.targetGroup,
    });
  }
  if (busy && !force) {
    played.push({ group, opts, status: 'failed', reason: 'start-rejected' });
    return Promise.resolve({ status: 'failed', reason: 'start-rejected', group });
  }
  busy = true;
  const gen = ++generation;
  director.commit(decision.targetGroup || group);
  played.push({ group, opts, status: 'ok' });
  const result = {
    status: 'ok',
    slot: decision.slot,
    dir: decision.dir,
    group: decision.targetGroup || group,
  };
  if (opts && opts.awaitFinish) {
    return Promise.resolve().then(() => {
      if (generation === gen) busy = false;
      return result;
    });
  }
  return Promise.resolve(result);
}

globalThis.window = globalThis;
globalThis.document = document;
globalThis.localStorage = localStorage;
globalThis.location = { search: '?noauto=1', href: 'http://localhost/?noauto=1' };
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.setTimeout = setTimeout;
globalThis.clearTimeout = clearTimer;
globalThis.setInterval = setInterval;
globalThis.clearInterval = clearTimer;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.Audio = class {
  play() {
    return Promise.resolve();
  }
};
globalThis.fetch = async (_url, opts) => {
  if (opts && opts.body) {
    try {
      const body = JSON.parse(opts.body);
      if (body && body.event) events.push(body.event);
    } catch {
      /* 不是回执 */
    }
  }
  return { ok: false, json: async () => null, text: async () => '' };
};

globalThis.DSH_L2D = {
  admitAct(input) {
    return gate.admit(input);
  },
  finishAct(runId) {
    return gate.finish(runId);
  },
  releaseAct(runId, reason) {
    return gate.release(runId, reason);
  },
  currentAct() {
    return gate.current();
  },
  noteActMotion(runId, reason, kind) {
    gate.noteMotion(runId, reason, kind === 'skip' ? 'skip' : 'fail');
  },
  motionResultKind,
  actPhaseTemplate(name) {
    return getActPhaseTemplate(name);
  },
  closeMotionsOnPreempt,
  preemptedYandere,
  motionsShareArm,
  playMotionAsync,
  getMotionSlots() {
    return director.slotStates();
  },
  injectEmotionIntent(intent) {
    if (intent && intent.expression) state.expression = intent.expression;
    if (intent && intent.motion) void playMotionAsync(intent.motion);
    return true;
  },
  setExpression(name) {
    state.expression = name;
    return true;
  },
  clearExpression() {
    state.expression = null;
    return true;
  },
  resetPerformance() {
    state.expression = null;
    return { ok: true, params: 0 };
  },
  lookAt() {},
  setStageBusy() {},
  isReady() {
    return false;
  },
  markActive() {},
};

vm.runInThisContext(readFileSync(join(here, 'overlay.js'), 'utf8'), { filename: 'overlay.js' });
document.readyState = 'complete';
for (const fn of docListeners.DOMContentLoaded || []) fn();

function bubbleEl() {
  return queryAll(body, '.l2d-bubble')[0] || null;
}

function bubbleText() {
  const el = bubbleEl();
  return el ? el.textContent : '';
}

function clearBubble() {
  const el = bubbleEl();
  if (el) el.textContent = '';
}

function vignetteOn() {
  for (const el of body.children) {
    if (el.classList && el.classList.contains('l2d-yandere-fx')) return el.classList.contains('on');
  }
  return false;
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const ui = globalThis.DSH_L2D_UI;

async function bootYandere() {
  timers.length = 0;
  ui.disableYandere();
  await settle();
  director.reset();
  state.expression = null;
  releaseMotion();
  played.length = 0;
  events.length = 0;
  timers.length = 0;
  ui.enableYandere();
  await settle();
  clearBubble();
}

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exitCode = 1;
  }
};

console.log('\n邪神常驻与按手收招\n');

await test('状态机同一时刻只收一个普通动作，后一个被吞掉', async () => {
  director.reset();
  releaseMotion();
  const first = await playMotionAsync('抚胸手打开');
  const second = await playMotionAsync('狗尾巴草打开');
  assert.equal(first.status, 'ok');
  assert.equal(second.reason, 'start-rejected');
  assert.equal(director.slotStates()['狗尾巴草'], 'closed');
  releaseMotion();
  director.reset();
});

await test('开场被戳，首步是抚胸手打开：不补播关闭，槽保持 open', async () => {
  await bootYandere();
  releaseMotion();
  const mark = played.length;
  const result = ui.executePokeAction({
    priority: 'FORCE',
    source: 'poke',
    silent: true,
    callId: 21,
    chain: [{ kind: 'motion', name: '抚胸手打开' }],
  });
  assert.equal(result.accepted, true);
  await settle();
  const after = played.slice(mark);
  assert.equal(after.some((item) => item.group === '抚胸手关闭'), false);
  assert.equal(director.slotStates()['抚胸手'], 'open');
  assert.equal(vignetteOn(), true);
  assert.equal(state.expression, '黑脸');
  flushTimers(3000);
  await settle();
  const end = events.find((event) => event.phase === 'end' && event.runId === result.runId);
  assert.ok(end);
  assert.equal(end.reason, undefined);
  assert.deepEqual(end.notes, ['already-open']);
  assert.notEqual(bubbleText(), '这个动作先让位');
});

await test('开场被戳，首步是狗尾巴草打开：草最终 open，左手收回', async () => {
  await bootYandere();
  releaseMotion();
  const mark = played.length;
  const result = ui.executePokeAction({
    priority: 'FORCE',
    source: 'poke',
    silent: true,
    callId: 22,
    chain: [{ kind: 'motion', name: '狗尾巴草打开' }],
  });
  assert.equal(result.accepted, true);
  await settle();
  const after = played.slice(mark);
  assert.deepEqual(after.map((item) => item.group), ['狗尾巴草打开', '抚胸手关闭']);
  assert.equal(after.every((item) => item.status === 'ok'), true);
  assert.equal(director.slotStates()['狗尾巴草'], 'open');
  assert.equal(director.slotStates()['抚胸手'], 'closed');
  assert.equal(vignetteOn(), true);
  assert.equal(state.expression, '黑脸');
  assert.notEqual(bubbleText(), '这个动作先让位');
});

await test('开场被戳，首步是竖手指打开：不弹让位气泡，手指 open，左手收回', async () => {
  await bootYandere();
  releaseMotion();
  const mark = played.length;
  ui.executePokeAction({
    priority: 'FORCE',
    source: 'poke',
    silent: true,
    callId: 26,
    chain: [{ kind: 'motion', name: '竖手指打开' }],
  });
  await settle();
  const after = played.slice(mark);
  assert.deepEqual(after.map((item) => item.group), ['竖手指打开', '抚胸手关闭']);
  assert.equal(after.every((item) => item.status === 'ok'), true);
  assert.equal(director.slotStates()['竖手指'], 'open');
  assert.equal(director.slotStates()['抚胸手'], 'closed');
  assert.notEqual(bubbleText(), '这个动作先让位');
});

await test('新链没有 motion：照常补播抚胸手关闭', async () => {
  await bootYandere();
  releaseMotion();
  const mark = played.length;
  ui.executePokeAction({
    priority: 'FORCE',
    source: 'poke',
    silent: true,
    callId: 23,
    chain: [{ kind: 'look', x: 0, y: 0 }],
  });
  await settle();
  const after = played.slice(mark);
  assert.equal(after.some((item) => item.group === '抚胸手关闭' && item.status === 'ok'), true);
  assert.equal(director.slotStates()['抚胸手'], 'closed');
});

await test('9 秒后戳：暗角和黑脸都还在', async () => {
  await bootYandere();
  releaseMotion();
  assert.equal(vignetteOn(), true);
  assert.equal(state.expression, '黑脸');
  flushTimers(9000);
  await settle();
  assert.equal(vignetteOn(), true);
  assert.equal(state.expression, '黑脸');
  ui.executePokeAction({
    priority: 'FORCE',
    source: 'poke',
    silent: true,
    callId: 24,
    chain: [{ kind: 'look', x: 0, y: 0.1 }],
  });
  await settle();
  assert.equal(vignetteOn(), true);
  assert.equal(state.expression, '黑脸');
});

await test('菜单关闭：暗角、黑脸、抚胸手都收干净', async () => {
  await bootYandere();
  assert.equal(vignetteOn(), true);
  assert.equal(state.expression, '黑脸');
  assert.equal(director.slotStates()['抚胸手'], 'open');
  assert.equal(busy, true);
  const mark = played.length;
  ui.disableYandere();
  await settle();
  const closes = played.slice(mark).filter((item) => item.group === '抚胸手关闭');
  assert.equal(closes.length >= 1, true);
  assert.equal(closes[0].status, 'ok');
  assert.equal(closes[0].opts.interrupt, true);
  assert.equal(director.slotStates()['抚胸手'], 'closed');
  assert.equal(vignetteOn(), false);
  assert.equal(state.expression, null);
});

await test('动作还占着状态机时新动作被吞，结束回执带 start-rejected', async () => {
  await bootYandere();
  const result = ui.executePokeAction({
    priority: 'FORCE',
    source: 'poke',
    silent: true,
    callId: 25,
    chain: [{ kind: 'motion', name: '竖手指打开' }],
  });
  await settle();
  flushTimers(3000);
  await settle();
  const end = events.find((event) => event.phase === 'failed' && event.runId === result.runId);
  assert.ok(end);
  assert.equal(end.reason, 'start-rejected');
  assert.equal(bubbleText(), '这个动作先让位');
  assert.equal(director.slotStates()['竖手指'], 'closed');
});

await test('连发两句 speaking：手指照样举着，end 没有失败 reason', async () => {
  timers.length = 0;
  director.reset();
  releaseMotion();
  played.length = 0;
  events.length = 0;
  clearBubble();
  ui.executePokeAction({
    phase: 'speaking',
    priority: 'FORCE',
    silent: true,
    callId: 31,
    source: 'speaking',
  });
  flushTimers(400);
  await settle();
  releaseMotion();
  assert.equal(director.slotStates()['竖手指'], 'open');
  const second = ui.executePokeAction({
    phase: 'speaking',
    priority: 'FORCE',
    silent: true,
    callId: 32,
    source: 'speaking',
  });
  flushTimers(400);
  await settle();
  // 第二句碰到已经举起的手指，槽保持 open，这时还没到它自己的关闭时间。
  assert.equal(director.slotStates()['竖手指'], 'open');
  flushTimers(4000);
  await settle();
  const end = events.find((event) => event.phase === 'end' && event.runId === second.runId);
  assert.ok(end);
  assert.equal(end.reason, undefined);
  assert.deepEqual(end.notes, ['already-open']);
  assert.notEqual(bubbleText(), '这个动作先让位');
});

await test('补关闭会等到 motion 的 delayMs 再播', async () => {
  await bootYandere();
  releaseMotion();
  const mark = played.length;
  ui.executePokeAction({
    priority: 'FORCE',
    source: 'poke',
    silent: true,
    callId: 41,
    chain: [{ kind: 'motion', name: '狗尾巴草打开', delayMs: 500 }],
  });
  await settle();
  assert.equal(played.slice(mark).some((item) => item.group === '狗尾巴草打开'), false);
  flushTimers(500);
  await settle();
  assert.deepEqual(played.slice(mark).map((item) => item.group), ['狗尾巴草打开', '抚胸手关闭']);
  assert.notEqual(bubbleText(), '这个动作先让位');
});

if (process.exitCode) {
  console.error('\n邪神收招测试失败\n');
} else {
  console.log(`\n${passed} passed\n`);
}
