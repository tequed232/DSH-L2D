/**
 * Emotion_Router —— 情绪路由（docs/DSH-L2D-行为系统设计-v0.1.md 的 L2.5/L2.6 落地版）
 *
 * 分层契约（与文档一致）：
 *   传感器（可插拔，外部注入信号） → Emotion_Router（聚合/情绪惯性/规则路由/仲裁）
 *   → 输出 EmotionIntent（意图，不直接写参数）→ 执行器映射到
 *     l2d_set_expression / l2d_play_motion / setPose / lookAt / 气泡。
 *
 * 设计红线（照抄文档 §5/§6）：
 *   - 本模块【绝不】写 ParamMouthOpenY（口型禁区）与任何物理输出参数；
 *   - 同优先级不抢占，高优先级可打断；一切意图带 cooldown/hold，防抽搐；
 *   - mood（效价/唤醒）随时间回归 0（时间常数 ~60s），是状态之间的黏合剂。
 *
 * 本模块是纯逻辑：不碰 DOM、不碰 Cubism、不依赖 index.ts，可单测、可换模型。
 */

// ---------------------------------------------------------------- 公共类型

/** 情境（BehaviorDirector 的状态机；第一版由信号推断，带滞回） */
export type EmotionContext = 'idle' | 'conversation' | 'work' | 'away' | 'error';

/** 情绪惯性：valence ∈ [-1,1] 效价，arousal ∈ [0,1] 唤醒度 */
export interface MoodState {
  valence: number;
  arousal: number;
}

export type EmotionSignalType =
  | 'mouse'    // 位置/速度/点击频率
  | 'system'   // cpu/mem/battery/online
  | 'mood'     // 大模型隐藏标签 <mood>开心</mood>
  | 'chat'     // 对话事件（开始/结束/文本）
  | 'media'    // 媒体播放状态/节拍能量（可插拔，默认关）
  | 'state';   // 外部直接声明情境（如 agent-state 的 error）

export interface EmotionSignal {
  type: EmotionSignalType;
  /** 毫秒时间戳；缺省用 Date.now() */
  at?: number;
  data?: {
    // mouse
    x?: number;
    y?: number;
    /** px/s */
    vx?: number;
    vy?: number;
    /** 本次是否为点击（带 click 频率统计） */
    click?: boolean;
    // system（全部 0~1 归一化，battery 0~1，online 布尔）
    cpu?: number;
    mem?: number;
    battery?: number;
    charging?: boolean;
    online?: boolean;
    // mood：语义标签（见 MOOD_LEXICON）或直接给 valence/arousal
    mood?: string;
    valence?: number;
    arousal?: number;
    // chat / state
    text?: string;
    /** 'conversation' | 'work' | 'idle' | 'error' ... */
    state?: string;
    // media
    playing?: boolean;
    /** 0~1 音频能量峰值（节拍） */
    energy?: number;
    /** 检测到的 BPM，未知可不给 */
    bpm?: number;
  };
}

/**
 * 输出意图。执行器负责把它落到现有接口上：
 *   expression → l2d_set_expression
 *   motion/motionClose → l2d_play_motion（打开/关闭成对）
 *   pose → l2d_set_pose；look → lookAt；bubble → 气泡回调
 */
export interface EmotionIntent {
  /** 规则 id，执行端可做日志/去重 */
  ruleId: string;
  /** 信号来源标识，如 'sensor:system' / 'tag:<mood>' */
  source: string;
  /** 优先级：100 用户交互 / 80 对话 / 60 错误 / 50 情境 / 40 媒体 / 20 环境氛围 */
  priority: number;
  expression?: string | null;
  motion?: string | null;
  motionClose?: string | null;
  /** 打开类动作保持多久后播 closeMotion */
  closeAfterMs?: number;
  pose?: { right?: string; left?: string } | null;
  look?: { x: number; y: number } | null;
  bubble?: string | null;
  /**
   * 待机微动作。只在没有拖拽、媒体律动、成对动作、戳一戳链时由执行器播放。
   * tilt 歪头 / shift 重心 / shrug 耸肩 / puff 鼓腮 / pucker 嘟嘴。
   */
  ambient?: 'tilt' | 'shift' | 'shrug' | 'puff' | 'pucker' | null;
  /** 覆盖规则表上的冷却，用于把微动作间隔打散到 20~40 秒 */
  rearmMs?: number;
  /** 该意图拥有“脸面”的时长；期间低优先级意图被压制 */
  holdMs?: number;
}

/** 可插拔规则。match 命中且过冷却 → produce 一个意图 */
export interface EmotionRule {
  id: string;
  priority: number;
  /** 冷却（毫秒），防止同一条规则反复触发 */
  cooldownMs: number;
  /** 返回 true 表示命中（router 已保证至少间隔 cooldownMs） */
  match: (ctx: RouterSnapshot) => boolean;
  produce: (ctx: RouterSnapshot) => EmotionIntent | null;
}

/** 传给规则的只读快照 */
export interface RouterSnapshot {
  now: number;
  context: EmotionContext;
  mood: Readonly<MoodState>;
  /** 最近一次各系统信号（已做平滑） */
  system: {
    cpu: number;
    mem: number;
    battery: number; // -1 表示未知
    charging: boolean;
    online: boolean;
    cpuHighSince: number; // 0 = 未持续超阈
    memHighSince: number;
  };
  mouse: {
    lastMoveAt: number;
    lastClickAt: number;
    /** 3s 窗口内的点击数 */
    clicks3s: number;
    /** 平滑移动速度 0~1 */
    speed: number;
  };
  media: {
    playing: boolean;
    /** 0~1 平滑节拍能量 */
    energy: number;
    bpm: number;
  };
  /** 最近一次情绪标签（含时间） */
  lastMoodTag: { name: string; at: number } | null;
  lastErrorAt: number;
  lastChatAt: number;
  /** 微动作互斥门闩。任一为真就不要再叠待机小动作。 */
  gate: {
    drag: boolean;
    media: boolean;
    motion: boolean;
    acting: boolean;
  };
}

export interface EmotionRouterOptions {
  /** 规则表；缺省用 DEFAULT_RULES。换模型/换口味只换这张表 */
  rules?: EmotionRule[];
  /** 情绪回归时间常数（毫秒），文档建议 ~60s */
  moodTauMs?: number;
  /** cpu/mem 高负载判定阈值（0~1）与最短持续时间 */
  highThreshold?: number;
  highForMs?: number;
  /** 低电量阈值（0~1） */
  batteryLow?: number;
  /** 每 tick 记录诊断 */
  debug?: boolean;
}

// ---------------------------------------------------------------- 词典

/**
 * 语义 → 本模型表情（docs §4.2 要求外置；这里先内置，字段名与
 * dist/capabilities.json 的 expressions[].name 一一对应，实测枚举）。
 * 键统一小写；中英文/常见英文标签都收。
 */
export const MOOD_LEXICON: Record<string, string> = {
  // 正效价
  '开心': '兔牙', '高兴': '兔牙', '快乐': '兔牙', 'joy': '兔牙', 'happy': '兔牙',
  'cute': '兔牙', '可爱': '兔牙',
  '害羞': '脸红', '羞': '脸红', 'blush': '脸红', 'shy': '脸红',
  '爱': '爱心眼', '喜欢': '爱心眼', 'love': '爱心眼',
  '得意': '屑', '坏笑': '屑', 'smug': '屑', '调皮': '屑',
  // 负效价
  '生气': '黑脸', '愤怒': '黑脸', 'angry': '黑脸',
  '悲伤': '流泪', '难过': '流泪', '哭': '流泪', 'sad': '流泪', 'cry': '流泪',
  // 高唤醒
  '惊讶': '钢盆', '震惊': '钢盆', 'surprise': '钢盆', 'shock': '钢盆',
  '紧张': '流冷汗', '心虚': '流冷汗', '尴尬': '流冷汗', 'nervous': '流冷汗',
  '抱歉': '流冷汗', 'sweat': '流冷汗',
  // 低唤醒 / 中性
  '思考': '加载', 'thinking': '加载', 'loading': '加载', '困惑': '加载',
  '认真': '单片眼镜', '专注': '单片眼镜', 'smart': '单片眼镜',
  '犯困': '＞＜', '困': '＞＜', ' sleepy ': '＞＜', '累': '＞＜',
  '头晕': '圈圈眼', '晕': '圈圈眼', 'dizzy': '圈圈眼',
};

export function lookupMoodExpression(name: string): string | null {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return MOOD_LEXICON[key] || null;
}

// ---------------------------------------------------------------- 内置规则

/**
 * 默认规则表（优先级遵循 docs §5）。
 * 注意所有 bubble 都很短，且规则都有冷却 —— 防止“抽搐式”表演。
 */
export const DEFAULT_RULES: EmotionRule[] = [
  {
    id: 'mood-tag',
    priority: 80,
    cooldownMs: 4000,
    match: (s) => !!s.lastMoodTag && s.now - s.lastMoodTag.at < 1500,
    produce: (s) => {
      if (!s.lastMoodTag) return null;
      const expression = lookupMoodExpression(s.lastMoodTag.name);
      if (!expression) return null;
      return {
        ruleId: 'mood-tag',
        source: 'tag:' + s.lastMoodTag.name,
        priority: 80,
        expression,
        holdMs: 3000,
      };
    },
  },
  {
    id: 'error-state',
    priority: 60,
    cooldownMs: 30000,
    match: (s) => s.lastErrorAt > 0 && s.now - s.lastErrorAt < 2000,
    produce: (s) => ({
      ruleId: 'error-state',
      source: 'state:error',
      priority: 60,
      expression: '流冷汗',
      look: { x: 0, y: -0.18 },
      bubble: '呜…出了点问题',
      holdMs: 5000,
    }),
  },
  {
    id: 'cpu-high',
    priority: 50,
    cooldownMs: 90000,
    match: (s) => s.system.cpuHighSince > 0 && s.now - s.system.cpuHighSince > 8000,
    produce: (s) => ({
      ruleId: 'cpu-high',
      source: 'sensor:system',
      priority: 50,
      expression: '流冷汗',
      bubble: '电脑好烫…你没事吧',
      holdMs: 6000,
    }),
  },
  {
    id: 'mem-high',
    priority: 50,
    cooldownMs: 90000,
    match: (s) => s.system.memHighSince > 0 && s.now - s.system.memHighSince > 8000,
    produce: () => ({
      ruleId: 'mem-high',
      source: 'sensor:system',
      priority: 50,
      expression: '＞＜',
      bubble: '内存要满啦',
      holdMs: 5000,
    }),
  },
  {
    id: 'net-offline',
    priority: 55,
    cooldownMs: 60000,
    match: (s) => !s.system.online,
    produce: () => ({
      ruleId: 'net-offline',
      source: 'sensor:system',
      priority: 55,
      expression: '钢盆',
      bubble: '断、断网了？！',
      holdMs: 5000,
    }),
  },
  {
    id: 'battery-low',
    priority: 50,
    cooldownMs: 300000, // 5 分钟提醒一次就够
    match: (s) => s.system.battery >= 0 && s.system.battery < 0.2 && !s.system.charging,
    produce: (s) => ({
      ruleId: 'battery-low',
      source: 'sensor:system',
      priority: 50,
      expression: '＞＜',
      bubble: '只剩 ' + Math.round(s.system.battery * 100) + '% 电了…',
      holdMs: 5000,
    }),
  },
  {
    id: 'click-hyper',
    priority: 50,
    cooldownMs: 30000,
    match: (s) => s.mouse.clicks3s >= 6,
    produce: () => ({
      ruleId: 'click-hyper',
      source: 'sensor:mouse',
      priority: 50,
      expression: '圈圈眼',
      bubble: '别戳啦，头都晕了',
      holdMs: 3000,
    }),
  },
  {
    id: 'ambient-micro',
    priority: 20,
    cooldownMs: 20000,
    match: (s) =>
      !s.gate.drag && !s.gate.media && !s.gate.motion && !s.gate.acting,
    produce: () => {
      const kinds = ['tilt', 'shift', 'shrug', 'puff', 'pucker'] as const;
      const kind = kinds[Math.floor(Math.random() * kinds.length)] || 'tilt';
      return {
        ruleId: 'ambient-micro',
        source: 'ambient',
        priority: 20,
        ambient: kind,
        // 一次微动作大约 2.4 秒，期间不再叠第二条
        holdMs: 2400,
        rearmMs: 20000 + Math.floor(Math.random() * 20001),
      };
    },
  },
];

// ---------------------------------------------------------------- Router

interface ActiveIntent {
  intent: EmotionIntent;
  expiresAt: number;
}

export class EmotionRouter {
  private rules: EmotionRule[];
  private moodTauMs: number;
  private highThreshold: number;
  private highForMs: number;
  private batteryLow: number;
  private debug: boolean;

  private mood: MoodState = { valence: 0, arousal: 0 };
  private context: EmotionContext = 'idle';

  private lastFired = new Map<string, number>();
  private active: ActiveIntent | null = null;
  private subscribers = new Set<(intent: EmotionIntent) => void>();

  // 聚合状态（由 ingest 更新）
  private sys = {
    cpu: 0,
    mem: 0,
    battery: -1,
    charging: false,
    online: true,
    cpuHighSince: 0,
    memHighSince: 0,
  };
  private mouse = { lastMoveAt: 0, lastClickAt: 0, clicks3s: 0, speed: 0 };
  private media = { playing: false, energy: 0, bpm: 0 };
  private lastMoodTag: { name: string; at: number } | null = null;
  private lastErrorAt = 0;
  private lastChatAt = 0;
  private lastTickAt = 0;
  private clicksWindow: number[] = [];
  private lastIntentAt = 0;
  private gate = { drag: false, media: false, motion: false, acting: false };

  constructor(opts: EmotionRouterOptions = {}) {
    this.rules = opts.rules || DEFAULT_RULES;
    this.moodTauMs = opts.moodTauMs || 60000;
    this.highThreshold = opts.highThreshold ?? 0.85;
    this.highForMs = opts.highForMs ?? 8000;
    this.batteryLow = opts.batteryLow ?? 0.2;
    this.debug = !!opts.debug;
    // 进页面不要立刻做第一个微动作，先等一轮冷却
    this.lastFired.set('ambient-micro', Date.now());
  }

  /** 拖拽、媒体律动、成对动作、戳一戳进行中时关掉微动作。 */
  setGate(partial: Partial<RouterSnapshot['gate']>): void {
    if (typeof partial.drag === 'boolean') this.gate.drag = partial.drag;
    if (typeof partial.media === 'boolean') this.gate.media = partial.media;
    if (typeof partial.motion === 'boolean') this.gate.motion = partial.motion;
    if (typeof partial.acting === 'boolean') this.gate.acting = partial.acting;
  }

  // ---- 订阅（执行器注册在这里）----

  subscribe(fn: (intent: EmotionIntent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  // ---- 信号入口 ----

  /** 传感器/外部统一从这里喂信号。任何顺序、任何频率都安全。 */
  ingest(signal: EmotionSignal): void {
    const now = signal.at ?? Date.now();
    const d = signal.data || {};
    switch (signal.type) {
      case 'mouse': {
        this.mouse.lastMoveAt = now;
        if (typeof d.vx === 'number' || typeof d.vy === 'number') {
          const speed = Math.min(1, Math.hypot(d.vx || 0, d.vy || 0) / 2000);
          this.mouse.speed += (speed - this.mouse.speed) * 0.3;
        }
        if (d.click) {
          this.mouse.lastClickAt = now;
          // 3s 滑动窗口计数
          this.clicksWindow.push(now);
          while (this.clicksWindow.length && now - this.clicksWindow[0] > 3000) {
            this.clicksWindow.shift();
          }
          this.mouse.clicks3s = this.clicksWindow.length;
          // 点击 = 微正效价 + 唤醒
          this.mood.valence = clampRange(this.mood.valence + 0.04, -1, 1);
          this.mood.arousal = clampRange(this.mood.arousal + 0.08, 0, 1);
          this.lastChatAt = this.lastChatAt; // 点击不算对话
        }
        break;
      }
      case 'system': {
        if (typeof d.cpu === 'number') this.sys.cpu = d.cpu;
        if (typeof d.mem === 'number') this.sys.mem = d.mem;
        if (typeof d.battery === 'number') this.sys.battery = d.battery;
        if (typeof d.charging === 'boolean') this.sys.charging = d.charging;
        if (typeof d.online === 'boolean') this.sys.online = d.online;
        break;
      }
      case 'mood': {
        this.lastMoodTag = { name: String(d.mood || ''), at: now };
        if (typeof d.valence === 'number') {
          this.mood.valence = clampRange(d.valence, -1, 1);
        }
        if (typeof d.arousal === 'number') {
          this.mood.arousal = clampRange(d.arousal, 0, 1);
        }
        break;
      }
      case 'chat': {
        this.lastChatAt = now;
        break;
      }
      case 'state': {
        if (d.state === 'error') this.lastErrorAt = now;
        break;
      }
      case 'media': {
        if (typeof d.playing === 'boolean') this.media.playing = d.playing;
        if (typeof d.energy === 'number') {
          this.media.energy += (d.energy - this.media.energy) * 0.4;
        }
        if (typeof d.bpm === 'number') this.media.bpm = d.bpm;
        break;
      }
    }
    // 采集即推理一次情境（tick 里还会再带滞回地修正）
    this.inferContext(now);
  }

  // ---- 主循环 ----

  /**
   * 心跳：由宿主每 ~250ms 调一次（或自己 setInterval）。
   * 职责：情绪衰减 → 情境滞回 → 规则评估 → 仲裁发射。
   */
  tick(now: number = Date.now()): void {
    if (this.lastTickAt && now - this.lastTickAt < 200) return; // 限频
    const dt = this.lastTickAt ? now - this.lastTickAt : 250;
    this.lastTickAt = now;

    // 1) 情绪惯性回归（指数衰减，时间常数 moodTauMs）
    const decay = Math.exp(-dt / this.moodTauMs);
    this.mood.valence *= decay;
    this.mood.arousal *= decay;

    // 1.5) 点击 3s 滑动窗口随时间自然过期：停手后 clicks3s 必须能归零，
    // 否则 click-hyper 之类的规则会一直看到旧计数。
    while (this.clicksWindow.length && now - this.clicksWindow[0] > 3000) {
      this.clicksWindow.shift();
    }
    this.mouse.clicks3s = this.clicksWindow.length;

    // 2) cpu/mem 持续高位计时（进入/退出都带滞回）
    this.sys.cpuHighSince = this.trackHigh(this.sys.cpuHighSince, this.sys.cpu, now);
    this.sys.memHighSince = this.trackHigh(this.sys.memHighSince, this.sys.mem, now);

    // 3) 情境滞回修正
    this.inferContext(now);

    // 4) 当前意图过期则释放
    if (this.active && now >= this.active.expiresAt) this.active = null;

    // 5) 规则评估 + 仲裁
    const snap = this.snapshot(now);
    for (const rule of this.rules) {
      const last = this.lastFired.get(rule.id) || 0;
      if (now - last < rule.cooldownMs) continue;
      if (this.active && rule.priority <= this.active.intent.priority) continue; // 不抢占同级/高级
      let hit = false;
      try {
        hit = rule.match(snap);
      } catch {
        hit = false;
      }
      if (!hit) continue;
      let intent: EmotionIntent | null = null;
      try {
        intent = rule.produce(snap);
      } catch {
        intent = null;
      }
      if (!intent) continue;
      this.emit(intent, now);
      break; // 一 tick 最多发一个意图，防抽搐
    }
  }

  /** 手动注入意图（给「病娇彩蛋」等特殊动作链用，绕过规则表但仍走仲裁） */
  injectIntent(intent: EmotionIntent, now: number = Date.now()): boolean {
    if (this.active && intent.priority <= this.active.intent.priority) return false;
    this.emit(intent, now);
    return true;
  }

  // ---- 查询 ----

  getMood(): Readonly<MoodState> {
    return this.mood;
  }

  getContext(): EmotionContext {
    return this.context;
  }

  snapshot(now: number): RouterSnapshot {
    return {
      now,
      context: this.context,
      mood: this.mood,
      system: { ...this.sys },
      mouse: { ...this.mouse },
      media: { ...this.media },
      lastMoodTag: this.lastMoodTag ? { ...this.lastMoodTag } : null,
      lastErrorAt: this.lastErrorAt,
      lastChatAt: this.lastChatAt,
      gate: { ...this.gate },
    };
  }

  diagnostics(): string {
    const active = this.active
      ? this.active.intent.ruleId + '@' + this.active.intent.priority
      : 'none';
    return (
      'ctx=' +
      this.context +
      ' mood=' +
      this.mood.valence.toFixed(2) +
      '/' +
      this.mood.arousal.toFixed(2) +
      ' active=' +
      active
    );
  }

  // ---- 内部 ----

  private emit(intent: EmotionIntent, now: number): void {
    const rule = this.rules.find((item) => item.id === intent.ruleId);
    const base = rule ? rule.cooldownMs : 0;
    const want = intent.rearmMs && intent.rearmMs > 0 ? intent.rearmMs : base;
    // last + base = now + want，这样下一次放行正好落在 want 毫秒之后
    this.lastFired.set(intent.ruleId, want > base ? now + want - base : now);
    this.lastIntentAt = now;
    const holdMs = intent.holdMs ?? 4000;
    this.active = { intent, expiresAt: now + holdMs };
    if (this.debug) console.info('[emotion-router]', intent.ruleId, intent.expression || '');
    for (const fn of this.subscribers) {
      try {
        fn(intent);
      } catch {
        /* 单个订阅者异常不影响路由 */
      }
    }
  }

  /** 带滞回的高位计时：超阈值开始计时，回落后清零 */
  private trackHigh(since: number, value: number, now: number): number {
    if (value >= this.highThreshold) return since || now;
    if (since && value >= this.highThreshold * 0.9) return since; // 退出滞回
    return 0;
  }

  /** 情境推断（docs §1：带滞回；CONVERSATION 优先，AWAY 靠系统级信号） */
  private inferContext(now: number): void {
    if (this.lastErrorAt && now - this.lastErrorAt < 10000) {
      this.context = 'error';
      return;
    }
    if (this.lastChatAt && now - this.lastChatAt < 8000) {
      this.context = 'conversation';
      return;
    }
    if (this.mouse.lastMoveAt && now - this.mouse.lastMoveAt < 5000) {
      this.context = 'work';
      return;
    }
    // 5 分钟无鼠标信号视为离席（真实离席检测属宿主能力，这里用信号缺失近似）
    if (this.mouse.lastMoveAt && now - this.mouse.lastMoveAt > 300000) {
      this.context = 'away';
      return;
    }
    this.context = 'idle';
  }
}

function clampRange(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 便捷构造：mood 标签信号 */
export function moodSignal(name: string): EmotionSignal {
  return { type: 'mood', data: { mood: name } };
}
