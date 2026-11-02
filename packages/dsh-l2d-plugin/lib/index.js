/**
 * dsh-l2d —— DSH 插件（host 侧）
 *
 * 职责：把一层「透明角色叠加层」注入到 DSH 的 Web UI 里。
 *
 * 注入通道（关键，照抄 dsh-whale-widget 的结论）：
 *   - 桌面壳的 index.html 从安装包静态 dist 直出，tapIndex 变换过不去；
 *     唯一通道是宿主启动时一次性收集的 `webserver/index-inject` 注入表。
 *   - 表里只支持两种 script 行，且处理不对称：
 *       kind: 'script'      → 内联 createElement + textContent，不 await，不可能失败
 *       kind: 'script-src'  → await loadScript(src)，失败会 reject 掉 __DSH_BOOT_READY__ ⇒ 应用起不来
 *     所以这里**必须**用内联 script 行，由我们自己建 <script src> 并吞掉 onerror。
 *   - 注入表在宿主启动时收集一次、无刷新路径，订阅晚于收集就永远进不了表。
 *     因此 apply() 里**第一件事**就是注册注入行，不能把 apply 本身挂在 inject 上等 webServer。
 *
 * 模型资源不外拷贝：按绝对路径从模型目录直读，遵守「模型文件不重新分发」的授权约束。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createAiInbox } from './ai-inbox.mjs';
import { createWorkspaceAgentBridge } from './workspace-agent.mjs';
import { createReverseLog } from './reverse-log.mjs';
import { normalizePresencePayload, writeEnvState } from './env-state.mjs';
import { readPersona, resetPersona, writePersona } from './persona.mjs';
import { isActionTool, summarizeSession } from './session-events.mjs';
import { setupPetWindow } from './pet-window.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY_FILE = path.join(PKG_ROOT, 'lib', 'overlay.js');

const L2D_ROOT = process.env.DSH_L2D_ROOT || 'D:/Desktop/DSH-L2D';
const MODEL_DIR =
  process.env.DSH_L2D_MODEL_DIR || path.join(L2D_ROOT, 'DeepSeek免费公皮', 'DeepSeek');

const CORE_FILE =
  process.env.DSH_L2D_CORE ||
  path.join(L2D_ROOT, 'vendor', 'cubism', 'CubismSdkForWeb-5-r.5', 'Core', 'live2dcubismcore.min.js');
const RENDERER_FILE = path.join(PKG_ROOT, 'assets', 'renderer.js');
const TEST_FILE = path.join(PKG_ROOT, 'assets', 'test.html');
const TOKENS_FILE = path.join(PKG_ROOT, 'assets', 'ui-tokens.css');
const PET_HTML_FILE = path.join(PKG_ROOT, 'lib', 'pet.html');
const PET_PRELOAD_FILE = path.join(PKG_ROOT, 'lib', 'pet-preload.cjs');
const MODEL_EXT = new Set(['.json', '.moc3', '.png', '.jpg', '.jpeg']);

const AVATAR_CANDIDATES = [
  path.join(MODEL_DIR, '大肥鱼.png'),
  path.join(MODEL_DIR, 'avatar.png'),
  path.join(MODEL_DIR, 'preview.png'),
];

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const injectRowText =
  '(function(){try{' +
  'var d=document.body||document.documentElement;if(!d)return;' +
  'if(document.querySelector("script[data-dsh-l2d]"))return;' +
  'var s=document.createElement("script");s.src="/dsh-l2d/overlay.js";s.async=true;' +
  's.setAttribute("data-dsh-l2d","1");s.onerror=function(){};d.appendChild(s)' +
  '}catch(e){}})()';

export const name = 'dsh-l2d';

/**
 * DSH 设置命名空间。
 * schemastery 是 DSH 内置依赖，但独立安装/打包环境可能没有；
 * 这里动态加载，拿不到时退化为普通配置对象：插件仍可运行，
 * 只是失去 DSH 原生设置页的类型校验，overlay 设置面板不受影响。
 */
const SETTINGS_SHAPE = {
  apiKey: { type: 'string', default: '', description: 'DeepSeek API Key，仅用于查询账户余额' },
  refreshSeconds: { type: 'number', default: 60, description: '余额自动刷新间隔（秒），最小 15' },
  soundEnabled: { type: 'boolean', default: true, description: '按下/松开角色时的音效' },
  soundVolume: { type: 'number', default: 0.7, description: '音效音量 0~1' },
  scale: { type: 'number', default: 1, description: '角色显示缩放 0.6~1.6' },
  eyeFollow: { type: 'boolean', default: true, description: '眼睛跟随鼠标（默认开；关掉则视线回到待机）' },
  agentLink: { type: 'boolean', default: true, description: '读取 DSH 工作区会话状态，驱动角色表情/动作链' },
  clickMode: { type: 'string', default: 'random', description: '单击角色动作：random 随机动作 / api DeepSeek 决定' },
  spontaneousChat: { type: 'boolean', default: true, description: '空闲/完成时让角色主动冒泡' },
  memeStyle: { type: 'boolean', default: true, description: '让动作/气泡带梗味人设' },
  memeLevel: { type: 'number', default: 50, description: '玩梗程度 0~100' },
  autoAct: { type: 'boolean', default: true, description: '空闲时让 API 定期编排小动作' },
  systemSensor: { type: 'boolean', default: false, description: '系统硬件监听（CPU/内存/电量/断网驱动表情），默认关' },
  mediaSensor: { type: 'boolean', default: false, description: '媒体律动（音乐节拍摇摆），默认关' },
  petWindow: { type: 'string', default: 'off', description: '桌宠独立窗：off 关闭（页内浮层）/ only 独立透明窗（页内浮层停用，重启生效）' },
  reverseEnabled: { type: 'boolean', default: true, description: '反向桥：模型交互事件回流宿主（l2d-reverse-state.json + /ai/poll 搭车）' },
};

let z = null;
try {
  z = (await import('@deepseek-ai/schemastery')).default;
} catch {
  z = null;
}

export const Config = z
  ? z.object({
      apiKey: z.string().default('').description('DeepSeek API Key，仅用于查询账户余额（留空则不显示余额）').extra('volatile', true),
      refreshSeconds: z.number().default(60).description('余额自动刷新间隔（秒），最小 15').extra('volatile', true),
      soundEnabled: z.boolean().default(true).description('按下/松开角色时的音效').extra('volatile', true),
      soundVolume: z.number().default(0.7).description('音效音量 0~1').extra('volatile', true),
      scale: z.number().default(1).description('角色显示缩放 0.6~1.6').extra('volatile', true),
      eyeFollow: z.boolean().default(true).description('眼睛跟随鼠标（默认开；关掉则视线回到待机）').extra('volatile', true),
      agentLink: z.boolean().default(true).description('读取 DSH 工作区会话状态，驱动角色表情/动作链').extra('volatile', true),
      clickMode: z.string().default('random').description('单击角色动作：random 随机动作 / api DeepSeek 决定').extra('volatile', true),
      spontaneousChat: z.boolean().default(true).description('空闲/完成时让角色主动冒泡').extra('volatile', true),
      memeStyle: z.boolean().default(true).description('让动作/气泡带梗味人设').extra('volatile', true),
      memeLevel: z.number().default(50).description('玩梗程度 0~100').extra('volatile', true),
      autoAct: z.boolean().default(true).description('空闲时让 API 定期编排小动作').extra('volatile', true),
      systemSensor: z.boolean().default(false).description('系统硬件监听（CPU/内存/电量/断网驱动表情），默认关').extra('volatile', true),
      mediaSensor: z.boolean().default(false).description('媒体律动（音乐节拍摇摆），默认关').extra('volatile', true),
      petWindow: z.string().default('off').description('桌宠独立窗：off 关闭（页内浮层）/ only 独立透明窗（页内浮层停用，重启生效）').extra('volatile', true),
      reverseEnabled: z.boolean().default(true).description('反向桥：模型交互事件回流宿主（l2d-reverse-state.json + /ai/poll 搭车）').extra('volatile', true),
    })
  : { ...SETTINGS_SHAPE };

/** 轻量信任栅栏：拒绝跨站请求，避免任意网页读到本地模型资源 */
function isCrossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return true;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const host = req.headers.host;
      if (new URL(origin).host !== host) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function sendBuffer(res, status, type, buf) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
}

function readJsonBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/** 给外部 fetch 一个硬超时：到点 abort，调用方按失败处理，不允许悬挂。 */
const EXTERNAL_FETCH_TIMEOUT_MS = 10000;
function fetchWithTimeout(url, options = {}, timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- 余额
// 独立实现：直接调用 DeepSeek 官方余额接口，不复用其它插件的中间端点。
// 凭据从 DSH 凭据服务读取（DEEPSEEK_API_KEY），插件本身不落盘任何密钥。
const BALANCE_TTL = 60 * 1000;
const balanceCache = { ts: 0, data: null, inflight: null };
const DIAG = path.join(os.tmpdir(), 'dsh-l2d.log');

function diag(msg) {
  try {
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

/** 从任意形状的对象里尽力提取「余额」数值与币种 */
function normalizeLoose(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const seen = new Set();
  const queue = [obj];
  let fallback = null;
  while (queue.length && seen.size < 60) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (/total.?balance|^total$|remaining|balance$/i.test(k)) {
          if (!fallback) fallback = { total: v, currency: cur.currency || cur.unit || 'CNY' };
        }
      } else if (typeof v === 'string' && /^[A-Z]{3}$/.test(v)) {
        if (fallback) fallback.currency = v;
      } else if (v && typeof v === 'object') {
        queue.push(v);
      }
    }
  }
  return fallback;
}

/** 读取 DSH 版本，账号服务要求一个稳定的客户端身份；拿不到时给安全兜底。 */function readDshVersion() {
  try {
    if (process.env.DSH_VERSION) return String(process.env.DSH_VERSION);
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const versionFile = path.join(home, 'version');
    if (fs.existsSync(versionFile)) {
      const text = fs.readFileSync(versionFile, 'utf8').trim();
      if (text) return text;
    }
    const pkgFile = path.join(home, 'package.json');
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg && pkg.version) return String(pkg.version);
    }
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

async function getBalance(ctx, cfg = {}) {
  const now = Date.now();
  const ttl = Math.max(15, Number(cfg && cfg.refreshSeconds) || 60) * 1000;
  if (balanceCache.data && now - balanceCache.ts < ttl) return balanceCache.data;
  if (balanceCache.inflight) return balanceCache.inflight;

  balanceCache.inflight = (async () => {
    try {
      // ① API Key 路径：直接调 DeepSeek 官方余额接口
      // ① 设置里手填的 Key 优先（用户可在 DSH 设置中自行填写）
      let key = (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) || null;
      try {
        const cred = ctx.credentials || (typeof ctx.get === 'function' ? ctx.get('credentials') : null);
        if (!key && cred && typeof cred.resolve === 'function') key = await cred.resolve('DEEPSEEK_API_KEY');
      } catch (err) {
        diag('credentials.resolve 失败: ' + String(err && err.message));
      }
      if (!key) key = process.env.DEEPSEEK_API_KEY || null;

      if (key) {
        const res = await fetchWithTimeout('https://api.deepseek.com/user/balance', {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const info = (json.balance_infos && json.balance_infos[0]) || {};
        const total = Number(info.total_balance);
        const out = {
          ok: true,
          source: 'api-key',
          available: !!json.is_available,
          currency: info.currency || 'CNY',
          total: Number.isFinite(total) ? total : null,
          granted: Number(info.granted_balance) || 0,
          toppedUp: Number(info.topped_up_balance) || 0,
          ts: Date.now(),
        };
        balanceCache.ts = Date.now();
        balanceCache.data = out;
        return out;
      }

      // ② 账号登录态：走 DSH 自己的账号服务（插件不接触任何令牌）
      let acct = null;
      try {
        acct = ctx.get ? ctx.get('deepseekAccount') : ctx.deepseekAccount;
      } catch {
        acct = null;
      }
      if (acct && typeof acct.getBalance === 'function') {
        try {
          // 账号服务要求一个「调用方身份」，字段与 DSH 客户端内部一致
          const version = readDshVersion();
          const client = {
            version,
            locale: 'zh',
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          };
          const raw = await acct.getBalance(client);
          diag('account.getBalance -> ' + JSON.stringify(raw).slice(0, 900));
          const payload = raw && raw.ok ? raw.value : null;
          const norm = normalizeLoose(payload);
          if (norm) {
            const out = { ok: true, source: 'account', currency: norm.currency, total: norm.total, ts: Date.now() };
            balanceCache.ts = Date.now();
            balanceCache.data = out;
            return out;
          }
        } catch (err) {
          diag('account.getBalance 抛错: ' + String(err && err.message));
        }
      }

      const miss = { ok: false, reason: 'no-key', hint: '未检测到 API Key 或账号登录态' };
      balanceCache.ts = Date.now();
      balanceCache.data = miss;
      return miss;
    } catch (err) {
      const prev = balanceCache.data;
      const aborted = err && err.name === 'AbortError';
      const fallback =
        prev && prev.ok
          ? { ...prev, stale: true }
          : {
              ok: false,
              reason: aborted ? 'timeout' : 'fetch-failed',
              hint: String(err && err.message ? err.message : err),
            };
      balanceCache.ts = Date.now();
      balanceCache.data = fallback;
      return fallback;
    } finally {
      balanceCache.inflight = null;
    }
  })();

  return balanceCache.inflight;
}

// ---------------------------------------------------------------- 音效
// 用户可自定义：把 mp3/wav 放进 $DSH_HOME/l2d-audio/ 即可被前端随机取用。
// 没有自定义文件时，前端用 WebAudio 合成「小黄鸭」音，不依赖任何外部素材。
const AUDIO_DIR =
  process.env.DSH_L2D_AUDIO_DIR ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'l2d-audio');
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a']);

// ---------------------------------------------------------------- 设置持久化
// 与 whale 的 size.json 同构：宿主侧落盘，客户端通过 GET/PUT 读写，刷新后保持。
const SETTINGS_FILE = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'l2d-settings.json',
);

const SETTINGS_DEFAULT = {
  apiKey: '',
  refreshSeconds: 60,
  soundEnabled: true,
  soundVolume: 0.7,
  scale: 1,
  eyeFollow: true,
  agentLink: true,
  systemSensor: false,
  mediaSensor: false,
  petWindow: 'off',
  reverseEnabled: true,
  petMode: true,
};

function readSettings() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch {
    stored = {};
  }
  // 一次性迁移：eyeFollow / petMode 都曾是「旧默认噪音」（eyeFollow 是死配置无消费方，
  // petMode 是后来才变成正式行为），存量文件里的 false 不是用户选择。
  // 无标记时强制置 true 并打标；之后用户在面板里显式关掉才被尊重。
  // apiKey 脏值：历史上有对象被直接塞进这个字符串字段（存成 "[object Object]"），
  // 会让余额接口 401；这里统一清成空串（等价未配置，余额链路回落到 credentials/env）。
  let migrated = false;
  if (stored.eyeFollowMigrated !== true) {
    if (stored.eyeFollow === false) stored.eyeFollow = true;
    stored.eyeFollowMigrated = true;
    migrated = true;
  }
  if (stored.petModeMigrated !== true) {
    if (stored.petMode === false) stored.petMode = true;
    stored.petModeMigrated = true;
    migrated = true;
  }
  if (typeof stored.apiKey === 'string' && /^\[object /i.test(stored.apiKey.trim())) {
    stored.apiKey = '';
    migrated = true;
  }
  if (migrated) {
    try {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(stored, null, 2), 'utf8');
    } catch {
      /* 迁移写盘失败不影响读取，下次再试 */
    }
  }
  return { ...SETTINGS_DEFAULT, ...stored };
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) };
  // apiKey 脏值归一化（写路径兜底）：对象被塞进字符串字段会存成 "[object Object]"，会让余额 401。
  if (typeof next.apiKey === 'string' && /^\[object /i.test(next.apiKey.trim())) next.apiKey = '';
  // 约束取值范围，避免脏数据把前端弄坏
  next.soundVolume = Math.min(1, Math.max(0, Number(next.soundVolume) || 0));
  next.scale = Math.min(2.0, Math.max(0.6, Number(next.scale) || 1));
  next.refreshSeconds = Math.min(3600, Math.max(15, Number(next.refreshSeconds) || 60));
  next.agentLink = next.agentLink !== false;
  next.eyeFollow = next.eyeFollow !== false; // 默认开，显式 false 才关
  next.clickMode = next.clickMode === 'api' ? 'api' : 'random';
  next.spontaneousChat = next.spontaneousChat !== false;
  next.memeStyle = next.memeStyle !== false;
  next.memeLevel = Math.min(100, Math.max(0, Number(next.memeLevel) || 0));
  next.autoAct = next.autoAct !== false;
  next.systemSensor = next.systemSensor === true;
  next.mediaSensor = next.mediaSensor === true;
  next.petWindow = next.petWindow === 'only' ? 'only' : 'off';
  next.reverseEnabled = next.reverseEnabled !== false;
  next.petMode = next.petMode !== false; // 默认开：桌宠模式是正式行为，只有显式 false 才关
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    diag('writeSettings 失败: ' + String(err && err.message));
  }
  return next;
}

/**
 * 真实连接地址是否回环。Host 头可伪造，访问控制必须看 socket。
 * Node 侧三种回环形态都放行：IPv4、IPv6、IPv4-mapped IPv6。
 */
function isRemoteLoopback(req) {
  const remote = req.socket && req.socket.remoteAddress;
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/**
 * 只允许本机回环写入：Host 头可伪造，必须同时核对真实连接地址。
 * Host 层保留，用于挡 DNS-rebinding（此时 remoteAddress 也是回环）。
 */
function isLoopback(req) {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;
  return isRemoteLoopback(req);
}

function listAudio() {
  try {
    return fs
      .readdirSync(AUDIO_DIR)
      .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 工作区会话状态
// 参照 dsh-pet-indesktop 的 Agent Link：只读监听，不写不锁文件。
// DSH 的 session.v4.jsonl.zstd 是“多帧 zstd + JSONL”，必须按帧边界逐段解压。
const MAGIC_ZSTD = Buffer.from('28b52ffd', 'hex');
const AGENT_STATE_TTL = 1500;
let agentStateCache = { ts: 0, data: null };

function extractText(value, limit = 90) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, limit);
  if (Array.isArray(value)) {
    for (const part of value) {
      const text = part && typeof part.text === 'string' ? part.text : '';
      if (text) return text.slice(0, limit);
    }
  }
  return '';
}

function decompressZstdFrames(buffer) {
  const lines = [];
  let pos = 0;
  while (pos < buffer.length) {
    const start = buffer.indexOf(MAGIC_ZSTD, pos);
    if (start < 0) break;
    let end = buffer.indexOf(MAGIC_ZSTD, start + 1);
    if (end < 0) end = buffer.length;
    try {
      const text = zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
      for (const line of text.split(/\n/)) {
        if (line.trim()) lines.push(line);
      }
    } catch {
      // 单帧损坏不能拖垮状态读取
    }
    pos = end;
  }
  return lines;
}

function listSessionFiles() {
  const base = process.env.DSH_L2D_SESSION_DIR || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
  const files = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return files;
  }
  for (const dir of dirs) {
    const dirPath = path.join(base, dir.name);
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dirPath, entry.name, 'session.v4.jsonl.zstd');
      try {
        const stat = fs.statSync(file);
        files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size, workspace: dir.name, sessionId: entry.name });
      } catch {
        continue;
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function deriveAgentState(events, ageMs, workspace) {
  let state = 'idle';
  let lastUserText = '';
  let lastTool = '';
  let lastAssistantText = '';
  let lastError = '';
  let lastTime = 0;

  for (const event of events) {
    const type = event.type || '';
    const data = event.data || {};
    lastTime = Math.max(lastTime, Number(event.time) || 0);

    if (type === 'user/message') {
      const text = extractText(data.content || data.message?.content);
      if (text && data.source?.kind !== 'user-approval') lastUserText = text;
      state = 'thinking';
    } else if (type === 'step/start') {
      state = 'thinking';
    } else if (type === 'tool/call') {
      lastTool = String(data.name || data.kind || '');
      state = 'working';
    } else if (type === 'assistant/message') {
      const text = extractText(data.message?.content);
      if (text) lastAssistantText = text;
      state = 'thinking';
    } else if (type === 'turn/end') {
      const reason = data.reason || {};
      if (reason.kind === 'error' || reason.error) {
        lastError = String(reason.error?.message || reason.message || 'unknown error');
        state = 'error';
      } else {
        state = 'attention';
      }
    }
  }

  // 长时间没有事件就是 idle；错误保留更久，方便用户注意到失败。
  if (state !== 'error' && ageMs > 120000) state = 'idle';
  if (state === 'error' && ageMs > 600000) state = 'idle';

  return {
    ok: true,
    state,
    workspace,
    ageMs: Math.max(0, Math.round(ageMs)),
    lastUserText,
    lastTool,
    lastAssistantText,
    lastError,
    lastEventAt: lastTime,
  };
}

function getAgentState(force = false) {
  const now = Date.now();
  if (!force && agentStateCache.data && now - agentStateCache.ts < AGENT_STATE_TTL) {
    return agentStateCache.data;
  }
  let data = { ok: false, state: 'idle', reason: 'no-session' };
  try {
    const files = listSessionFiles();
    if (files.length) {
      const latest = files[0];
      const events = [];
      for (const line of decompressZstdFrames(fs.readFileSync(latest.file))) {
        try {
          events.push(JSON.parse(line));
        } catch {
          continue;
        }
      }
      data = deriveAgentState(events, now - latest.mtimeMs, latest.workspace);
    }
  } catch (err) {
    data = { ok: false, state: 'idle', reason: String(err && err.message ? err.message : err) };
  }
  agentStateCache = { ts: now, data };
  return data;
}

export { getAgentState };

let workspaceBridge = null;
const workspaceEventCache = new Map();

/** Workspace 状态只输出脱敏活动元数据，不向专属 Agent 暴露其他会话文本。
 *  每个会话额外带：最近一次工具调用（真实回执分类：isError/error.code/超时/中断/退出码）、
 *  最近 turn/end、上次动作回执、动作是否在途——供 L1 规划上下文使用。 */
function getWorkspaceAgentStates(registry) {
  const now = Date.now();
  const bySession = new Map(listSessionFiles().map((entry) => [entry.sessionId, entry]));
  const workspaces = [];
  const activeIds = new Set();
  for (const workspace of registry.list().slice(0, 100)) {
    const sessions = [];
    for (const sessionId of workspace.sessionIds.slice(0, 100)) {
      const id = String(sessionId);
      activeIds.add(id);
      const entry = bySession.get(id);
      if (!entry) {
        sessions.push({
          sessionIndex: sessions.length + 1,
          state: 'unknown',
          ageMs: null,
          hasError: false,
          lastTool: null,
          lastTurnEnd: null,
          lastAction: null,
          pendingAction: null,
        });
        continue;
      }
      let cached = workspaceEventCache.get(id);
      if (!cached || cached.mtimeMs !== entry.mtimeMs || cached.size !== entry.size) {
        try {
          const events = [];
          for (const line of decompressZstdFrames(fs.readFileSync(entry.file))) {
            try { events.push(JSON.parse(line)); } catch { /* ignore malformed event */ }
          }
          const summary = summarizeSession(events, { now: entry.mtimeMs });
          cached = { mtimeMs: entry.mtimeMs, size: entry.size, ...summary };
          workspaceEventCache.set(id, cached);
        } catch {
          cached = {
            mtimeMs: entry.mtimeMs,
            size: entry.size,
            state: 'unknown',
            lastEventAt: 0,
            lastTool: null,
            lastTurnEnd: null,
            lastAction: null,
            pendingTool: null,
            hasError: false,
          };
          workspaceEventCache.set(id, cached);
        }
      }
      const ageMs = Math.max(0, Math.round(now - entry.mtimeMs));
      let state = cached.state;
      if (state !== 'error' && ageMs > 120000) state = 'idle';
      if (state === 'error' && ageMs > 600000) state = 'idle';
      const pending = cached.pendingTool && isActionTool(cached.pendingTool.name)
        ? { name: cached.pendingTool.name, priority: 'NORMAL' }
        : null;
      sessions.push({
        sessionIndex: sessions.length + 1,
        state,
        ageMs,
        lastEventAt: cached.lastEventAt,
        hasError: state === 'error',
        lastTool: cached.lastTool || null,
        lastTurnEnd: cached.lastTurnEnd || null,
        lastAction: cached.lastAction || null,
        pendingAction: pending,
      });
    }
    workspaces.push({
      workspaceId: String(workspace.id),
      title: String(workspace.title || 'Untitled workspace'),
      sessions,
    });
  }
  for (const id of workspaceEventCache.keys()) {
    if (!activeIds.has(id)) workspaceEventCache.delete(id);
  }
  return { ok: true, generatedAt: new Date().toISOString(), workspaces };
}

// ---------------------------------------------------------------- 戳一戳 API 动作
// 用户单击角色时可选择「让 DeepSeek 决定动作」。为避免模型编参数，
// 只允许它从前端上报的白名单里挑：表情 / 动作组 / 四肢姿势 / 视线 / 气泡文案。
const POKE_API_COOLDOWN = 1200;
let lastPokeApiAt = 0;

function asStringList(value, maxItems = 80) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, maxItems);
}

function pickAllowed(value, list) {
  return typeof value === 'string' && list.includes(value) ? value : null;
}

/** 口型禁区：AI 关键帧一律不得写，留给以后的音频口型链路（与 core 的 LIPSYNC_PARAMS 对齐）。 */
const KEYFRAME_MOUTH_BLOCKLIST = ['ParamMouthOpenY', 'ParamMouthOpen', 'ParamMouthForm'];

function sanitizeKeyframeStep(step, allowedParams) {
  if (!step || !Array.isArray(step.tracks)) return null;
  const whitelist = Array.isArray(allowedParams) && allowedParams.length ? allowedParams : null;
  const tracks = [];
  for (const track of step.tracks.slice(0, 5)) {
    if (!track || typeof track.param !== 'string' || !Array.isArray(track.keys)) continue;
    if (KEYFRAME_MOUTH_BLOCKLIST.indexOf(track.param) >= 0) continue;
    if (whitelist && whitelist.indexOf(track.param) < 0) continue;
    const keys = [];
    for (const key of track.keys.slice(0, 10)) {
      if (!Array.isArray(key) || key.length < 2) continue;
      const time = Math.max(0, Math.min(10000, Number(key[0]) || 0));
      const value = Number(key[1]);
      if (!Number.isFinite(value)) continue;
      keys.push([time, value]);
    }
    if (keys.length >= 2) tracks.push({ param: track.param.slice(0, 80), keys });
  }
  if (!tracks.length) return null;
  return {
    kind: 'keyframes',
    tracks,
    duration: Math.max(500, Math.min(8000, Number(step.duration) || 1800)),
    loop: step.loop === true,
    delayMs: Math.max(0, Math.min(5000, Number(step.delayMs) || 0)),
  };
}

function sanitizePokeAction(raw, allowed) {
  if (!raw || typeof raw !== 'object') return null;

  // 参照 FULASKA/-live2d- 的动作协议：底层用 kind 化的步骤链，
  // 但保留旧字段 expression/motion/pose 兼容现有调用方。
  let chain = Array.isArray(raw.chain) ? raw.chain.slice(0, 6) : null;
  if (!chain) {
    chain = [];
    if (raw.expression) chain.push({ kind: 'expression', name: raw.expression });
    if (raw.motion) chain.push({ kind: 'motion', name: raw.motion, closeMotion: raw.closeMotion, closeAfterMs: raw.closeAfterMs });
    if (raw.pose) chain.push({ kind: 'pose', pose: raw.pose });
    if (raw.look) chain.push({ kind: 'look', x: raw.look?.[0], y: raw.look?.[1] });
  }

  const sanitizedChain = [];
  for (const step of chain) {
    if (!step || typeof step !== 'object') continue;
    const delayMs = Math.max(0, Math.min(5000, Number(step.delayMs) || 0));
    if (step.kind === 'expression') {
      const name = pickAllowed(step.name, allowed.expressions);
      if (name) sanitizedChain.push({ kind: 'expression', name, delayMs });
    } else if (step.kind === 'motion') {
      const name = pickAllowed(step.name, allowed.motions);
      if (name) {
        const closeName = pickAllowed(step.closeMotion, allowed.motions)
          || (name.endsWith('打开') && allowed.motions.includes(name.replace(/打开$/, '关闭'))
            ? name.replace(/打开$/, '关闭')
            : null);
        sanitizedChain.push({
          kind: 'motion',
          name,
          closeMotion: closeName,
          closeAfterMs: Math.max(2000, Math.min(12000, Number(step.closeAfterMs) || 6000)),
          delayMs,
        });
      }
    } else if (step.kind === 'pose') {
      const pose = step.pose && typeof step.pose === 'object' ? {
        right: pickAllowed(step.pose.right, ['rest', 'finger', 'grass', 'chest']),
        left: pickAllowed(step.pose.left, ['rest', 'finger', 'grass', 'chest']),
      } : null;
      if (pose && (pose.right || pose.left)) sanitizedChain.push({ kind: 'pose', pose, delayMs });
    } else if (step.kind === 'keyframes') {
      const keyframes = sanitizeKeyframeStep(step, allowed.safeParams);
      if (keyframes) sanitizedChain.push(keyframes);
    } else if (step.kind === 'look') {
      sanitizedChain.push({
        kind: 'look',
        x: Math.max(-1, Math.min(1, Number(step.x) || 0)),
        y: Math.max(-1, Math.min(1, Number(step.y) || 0)),
        delayMs,
      });
    }
  }

  if (!sanitizedChain.length && allowed.expressions.length) {
    sanitizedChain.push({ kind: 'expression', name: allowed.expressions[0], delayMs: 0 });
  }

  const bubble = typeof raw.bubble === 'string' ? raw.bubble.trim().slice(0, 40) : '';
  return { ok: true, kind: 'poke-action', chain: sanitizedChain, bubble };
}

function memeToneRules(level) {
  const n = Math.max(0, Math.min(100, Number(level) || 0));
  if (n <= 20) return '语气正常克制，不刻意玩梗；最多用“好的/来啦”这类自然口语。';
  if (n <= 45) return '轻度玩梗：可以用常见中文网络语气词，不硬解释梗，不用黑称。';
  if (n <= 70) return '中等玩梗：可以接通用梗和互动梗，短句、可爱、带一点小得意；不用黑称。';
  return '高玩梗：放开一点，可以用夸张网络语气和通用梗，但不要辱骂、不造谣、不用黑称。';
}

async function requestDeepSeekPokeAction(key, payload, style = {}) {
  const allowedText = {
    expressions: payload.expressions,
    motions: payload.motions,
    poses: ['rest', 'finger', 'grass', 'chest'],
    safeParams: payload.safeParams || [],
  };
  const system = [
    '你是 Live2D 桌面宠物的动作导演。',
    '用户触发一次角色动作，请返回轻量、可爱、不过度的动作链。',
    '只允许使用给定枚举值和安全参数，不要发明表情、动作组、姿势或参数名。',
    '动作不能同时占用冲突的右臂姿势：finger 和 grass 是右臂互斥；chest 用左臂。',
    '除了预设动作组，你应优先用 keyframes 编排更细腻的眼/嘴/头/身体微动作。',
    'keyframes 规则：最多 5 条轨道；每轨 2~10 个关键帧；总时长 500~8000ms；参数必须来自 safeParams。',
    '不要把同一帧写给互相打架的参数；动作结尾尽量回到自然值。',
    '通常 1~2 个步骤，不要每项都填满。',
    'bubble 最多 12 个汉字，不要加引号或 Markdown。',
    '严格返回 JSON：{ "chain": [步骤], "bubble": "..." }。',
    '步骤 kind 可用：expression / motion / pose / look / keyframes。',
    'expression: { kind, name, delayMs }；motion: { kind, name, closeMotion?, closeAfterMs?, delayMs }；',
    'pose: { kind, pose:{right?,left?}, delayMs }；look: { kind, x, y, delayMs }；',
    'keyframes: { kind, tracks:[{param,keys:[[ms,value],...]}], duration, loop?, delayMs }。',
    'delayMs 是相对上一步的等待毫秒，0 表示立刻。',
    'bubble 风格：' + memeToneRules(style.memeLevel),
    style.memeStyle === false
      ? '禁用玩梗：bubble 用自然、简短、不刻意搞笑的中文。'
      : '可以有梗味，但不要解释梗、不要使用黑称、不要发敏感或冒犯内容。',
  ].join('\n');
  const user = [
    '可用表情：' + JSON.stringify(allowedText.expressions),
    '可用动作组：' + JSON.stringify(allowedText.motions),
    '可用姿势：' + JSON.stringify(allowedText.poses),
    '安全参数（只可用这些做 keyframes）：' + JSON.stringify(allowedText.safeParams),
    '触发原因：用户触发一次角色动作。',
    '请返回 JSON。',
  ].join('\n');

  const model = process.env.DSH_L2D_API_MODEL || 'deepseek-chat';
  const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 1.1,
      max_tokens: 900,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${text.slice(0, 180)}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  let raw;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error('API 返回不是 JSON');
  }
  return sanitizePokeAction(raw, payload);
}

export function apply(root, config = {}) {
  // ① DSH 原生设置里填的 Key 同步进插件设置：balance.json 只读 l2d-settings.json。
  // 空字符串不覆盖，避免设置页默认值把用户已保存的 Key 冲掉。
  try {
    const nativeKey = String(config && config.apiKey ? config.apiKey : '').trim();
    if (nativeKey && readSettings().apiKey !== nativeKey) writeSettings({ apiKey: nativeKey });
  } catch (err) {
    diag('同步原生 apiKey 失败: ' + String(err && err.message));
  }

  // ② 立刻注册注入行：这一步不依赖任何服务，必须最先做
  try {
    root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return;
        // pet 窗 'only' 模式：页内浮层停用。aiInbox.poll 是抢占式取队列，
        // 双消费者会分食 AI 指令（proposals/pet-window-feasibility.md A8）。
        if (readSettings().petWindow === 'only') return;
        for (const row of table) {
          if (row && row.kind === 'script' && typeof row.text === 'string') {
            if (row.text.indexOf('/dsh-l2d/overlay.js') >= 0) return; // 已推过，不重复
          }
        }
        table.push({ kind: 'script', placement: 'body', text: injectRowText });
      } catch {
        /* 注入表异常不应影响宿主启动 */
      }
    });
  } catch (err) {
    console.warn('[dsh-l2d] 注册注入行失败：' + String(err && err.message ? err.message : err));
  }

  // ② 等 webServer / credentials 就绪后再挂路由
  root.inject(['webServer', 'credentials'], (ctx) => {
    // 头号会合点：把当前 DSH 端口写给 MCP 薄壳。
    // DSH 每次重启端口都会变，磁盘扫端口只能碰旧端口；MCP 的 discover 优先读这个文件。
    try {
      const origin =
        typeof ctx.webServer.getOrigin === 'function'
          ? ctx.webServer.getOrigin()
          : ctx.webServer.port
            ? `http://127.0.0.1:${ctx.webServer.port}`
            : '';
      if (origin) {
        const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(
          path.join(home, 'l2d-service.json'),
          JSON.stringify({ origin: String(origin).replace(/\/$/, ''), updatedAt: Date.now() }) + '\n',
        );
        diag('service file: ' + origin);
      }
    } catch (err) {
      diag('service file 写入失败: ' + String(err && err.message ? err.message : err));
    }

    const disposers = [];

    const route = (routePath, handler) => {
      try {
        const d = ctx.webServer.register({ kind: 'exact', path: routePath, handler });
        if (typeof d === 'function') disposers.push(d);
      } catch (err) {
        console.warn(`[dsh-l2d] 路由 ${routePath} 注册失败：` + String(err && err.message ? err.message : err));
      }
    };

    route('/dsh-l2d/overlay.js', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const buf = readIfExists(OVERLAY_FILE);
      if (!buf) return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('overlay.js missing'));
      sendBuffer(res, 200, MIME['.js'], buf);
    });

    route('/dsh-l2d/ui-tokens.css', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const buf = readIfExists(TOKENS_FILE);
      if (!buf) return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('ui-tokens.css missing'));
      sendBuffer(res, 200, MIME['.css'], buf);
    });

    route('/dsh-l2d/avatar.png', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      for (const candidate of AVATAR_CANDIDATES) {
        const buf = readIfExists(candidate);
        if (buf) return sendBuffer(res, 200, MIME['.png'], buf);
      }
      // 找不到立绘时返回 1×1 透明图，前端会切到内置的占位轮廓
      const px = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      );
      sendBuffer(res, 200, MIME['.png'], px);
    });

    // ------------------------------------------------------ AI 指令通道
    //
    // 任何外部 Agent（DSH 会话里的大模型、本地脚本、别的服务）都能通过 HTTP 驱动角色：
    //   POST /dsh-l2d/ai/call  { "name": "l2d_set_expression", "args": { "name": "兔牙" } }
    //   GET  /dsh-l2d/ai/poll  浏览器侧取走待执行队列
    // 用「队列 + 轮询」而不是 WebSocket：插件环境里没有长连接，轮询 400ms 足够，
    // 而且失败可重建，不会因为连接断了就哑掉。
    const aiInbox = createAiInbox();
    const reverseLog = createReverseLog({ diag });

    route('/dsh-l2d/ai/call', (req, res) => {
      if (!isRemoteLoopback(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('loopback only'));
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'POST') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
      }
      const chunks = [];
      req.on('data', (c) => {
        chunks.push(c);
        if (chunks.reduce((n, b) => n + b.length, 0) > 16 * 1024) req.destroy();
      });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};
        } catch {
          return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad json'));
        }
        const name = String(body.name || '').trim();
        if (!name) {
          return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('name required'));
        }
        // 只放行已知工具名，避免变成任意函数调用面
        const ALLOWED = new Set([
          'l2d_set_expression',
          'l2d_play_motion',
          'l2d_look_at',
          'l2d_set_parameters',
          'l2d_reset_pose',
          'l2d_play_keyframes',
          'l2d_stop_keyframes',
          'l2d_set_pose',
          // MCP 薄壳用的高层工具。低层 set_parameters / play_keyframes 仍只留给 HTTP 调试，不进 MCP。
          'l2d_emote',
          'l2d_gaze',
          'l2d_say',
          'l2d_act',
          'l2d_get_state',
          'l2d_reset',
        ]);
        if (!ALLOWED.has(name)) {
          return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown tool: ' + name));
        }
        const queued = aiInbox.call(name, body.args || {});
        sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(queued), 'utf8'));
      });
    });

    route('/dsh-l2d/ai/poll', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      // 搭车：把反向桥事件摘要一并带给页面，overlay 可并入 l2d_get_state
      const polled = aiInbox.poll();
      polled.reverse = reverseLog.snapshot();
      sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(polled), 'utf8'));
    });

    // 浏览器把执行回执和 action-done 事件放回来。MCP 用 id 取走。
    // result 是受理/失败（一个 id 一份）；event 是 start / end / interrupted，可先到后到。
    route('/dsh-l2d/ai/result', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method === 'GET') {
        let id = 0;
        try {
          id = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('id'));
        } catch {
          id = 0;
        }
        return sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(aiInbox.read(id)), 'utf8'));
      }
      if (req.method !== 'POST') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
      }
      const chunks = [];
      req.on('data', (c) => {
        chunks.push(c);
        if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};
        } catch {
          return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad json'));
        }
        const saved = aiInbox.post(body);
        if (!saved.ok) {
          return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from(saved.reason || 'id required'));
        }
        sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true }), 'utf8'));
      });
    });

    // ------------------------------------------------------ 桌宠独立窗页面
    // 只从本机 webServer 同源加载（模型/渲染资源零拷贝）；preload 走文件路径不走路由
    route('/dsh-l2d/pet.html', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const buf = readIfExists(PET_HTML_FILE);
      if (!buf) return sendBuffer(res, 404, 'text/html; charset=utf-8', Buffer.from('pet.html missing'));
      sendBuffer(res, 200, 'text/html; charset=utf-8', buf);
    });

    // ------------------------------------------------------ 反向桥（模型 → 宿主）
    // 事件白名单 + 回环 + 跨站栅栏 + 16KB 限流，与 /ai/call 同一套。
    // v1 只做 state handler（写状态文件 + /ai/poll 搭车）；notify/api-act 待立项。
    const REVERSE_TYPES = new Set(['pet', 'drag', 'idle', 'motion-done', 'expression-change', 'error', 'presence']);
    route('/dsh-l2d/reverse/event', (req, res) => {
      if (!isRemoteLoopback(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('loopback only'));
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'POST') return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
      if (readSettings().reverseEnabled === false) {
        return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('reverse disabled'));
      }
      const chunks = [];
      req.on('data', (c) => {
        chunks.push(c);
        if (chunks.reduce((n, b) => n + b.length, 0) > 16 * 1024) req.destroy();
      });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};
        } catch {
          return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad json'));
        }
        const type = String(body.type || '').trim();
        if (!REVERSE_TYPES.has(type)) {
          return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown type: ' + type.slice(0, 32)));
        }
        // 环境交互态：白名单字段 + 类型/范围校验后整份覆盖写 l2d-env-state.json。
        // 规划层读取时超过 30s 未更新按 unknown 处理，不会拿旧值误导动作规划。
        if (type === 'presence') {
          const normalized = normalizePresencePayload(body.payload, { now: Date.now() });
          if (!normalized.ok) {
            return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('invalid presence: ' + normalized.error));
          }
          let envSaved = false;
          try {
            writeEnvState(normalized.payload);
            envSaved = true;
          } catch (err) {
            diag('presence 落盘失败: ' + String(err && err.message ? err.message : err));
          }
          const ev = reverseLog.record(type, { name: normalized.payload.state });
          return sendBuffer(
            res,
            200,
            MIME['.json'],
            Buffer.from(JSON.stringify({ ok: true, accepted: true, handlers: ['state', 'env'], env: envSaved, ts: ev.ts }), 'utf8'),
          );
        }
        const ev = reverseLog.record(type, body.payload);
        sendBuffer(
          res,
          200,
          MIME['.json'],
          Buffer.from(JSON.stringify({ ok: true, accepted: true, handlers: ['state'], ts: ev.ts }), 'utf8'),
        );
      });
    });

    route('/dsh-l2d/reverse/state.json', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(reverseLog.full()), 'utf8'));
    });

    route('/dsh-l2d/status.json', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const avatar = AVATAR_CANDIDATES.find((p) => fs.existsSync(p)) || null;
      const body = JSON.stringify({
        version: '0.1.0-preview',
        modelDir: MODEL_DIR,
        avatarFound: !!avatar,
        avatar: avatar ? path.basename(avatar) : null,
        note: '当前为静态立绘预览；接入 Cubism Core 后替换为真实模型渲染',
      });
      sendBuffer(res, 200, MIME['.json'], Buffer.from(body, 'utf8'));
    });

    route('/dsh-l2d/balance.json', async (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const data = await getBalance(ctx, readSettings());
      sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(data), 'utf8'));
    });

    // 戳一戳「API 决定动作」：用用户自己的 DeepSeek Key 生成一次安全动作链
    route('/dsh-l2d/ai-action.json', async (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'POST') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
      }

      const sendJson = (status, payload) => {
        sendBuffer(res, status, MIME['.json'], Buffer.from(JSON.stringify(payload), 'utf8'));
      };

      try {
        const now = Date.now();
        if (now - lastPokeApiAt < POKE_API_COOLDOWN) {
          return sendJson(429, { ok: false, reason: 'cooldown' });
        }
        lastPokeApiAt = now;

        const body = await readJsonBody(req);
        const key = String(readSettings().apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
        if (!key) return sendJson(200, { ok: false, reason: 'no-key' });

        const allowed = {
          expressions: asStringList(body.expressions, 64),
          motions: asStringList(body.motions, 64)
            .filter((name) => name !== 'Idle'),
          safeParams: asStringList(body.safeParams, 48),
        };
        if (!allowed.expressions.length || !allowed.motions.length) {
          return sendJson(200, { ok: false, reason: 'empty-capabilities' });
        }
        const action = await requestDeepSeekPokeAction(key, allowed, {
          memeStyle: readSettings().memeStyle !== false,
          memeLevel: Number(readSettings().memeLevel) || 0,
        });
        sendJson(200, action);
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        diag('ai-action 失败: ' + message);
        sendJson(200, { ok: false, reason: 'api-failed', hint: message });
      }
    });

    route('/dsh-l2d/core.js', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const buf = readIfExists(CORE_FILE);
      if (!buf) {
        return sendBuffer(
          res,
          404,
          'text/plain; charset=utf-8',
          Buffer.from('Cubism Core 缺失，请把 SDK 的 Core/live2dcubismcore.min.js 放到 vendor/cubism/'),
        );
      }
      sendBuffer(res, 200, MIME['.js'], buf);
    });

    route('/dsh-l2d/renderer.js', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const buf = readIfExists(RENDERER_FILE);
      if (!buf) {
        return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('renderer.js 未构建：pnpm -F @dsh/renderer build'));
      }
      sendBuffer(res, 200, MIME['.js'], buf);
    });

    route('/dsh-l2d/test.html', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const buf = readIfExists(TEST_FILE);
      if (!buf) return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('test.html missing'));
      sendBuffer(res, 200, 'text/html; charset=utf-8', buf);
    });

    // 模型资源：prefix 路由，直接把模型目录当静态根，仍做扩展名白名单与穿越防护
    try {
      const d = ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-l2d/model',
        handler: (req, res) => {
          if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
          let rel = '';
          try {
            rel = decodeURIComponent(String(req.url || '').split('?')[0].replace(/^\/dsh-l2d\/model\/?/, ''));
          } catch {
            return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad path'));
          }
          if (!rel || rel.indexOf('..') >= 0) {
            return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found'));
          }
          const ext = path.extname(rel).toLowerCase();
          if (!MODEL_EXT.has(ext)) {
            return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('ext not allowed'));
          }
          const full = path.resolve(MODEL_DIR, rel);
          if (!full.startsWith(path.resolve(MODEL_DIR))) {
            return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('out of root'));
          }
          const buf = readIfExists(full);
          if (!buf) return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found'));
          const type =
            ext === '.json'
              ? 'application/json; charset=utf-8'
              : ext === '.moc3'
                ? 'application/octet-stream'
                : 'image/png';
          res.setHeader('Cache-Control', 'public, max-age=3600');
          sendBuffer(res, 200, type, buf);
        },
      });
      if (typeof d === 'function') disposers.push(d);
    } catch (err) {
      diag('model prefix 路由注册失败: ' + String(err && err.message));
    }

    route('/dsh-l2d/workspace/ensure', async (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'POST') return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
      if (!workspaceBridge) return sendBuffer(res, 503, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'dsh-workspace-services-unavailable' })));
      try {
        const result = await workspaceBridge.ensure();
        sendBuffer(res, result.ok ? 200 : 503, MIME['.json'], Buffer.from(JSON.stringify(result), 'utf8'));
      } catch (err) {
        sendBuffer(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'workspace-create-failed', hint: String(err?.message || err) }), 'utf8'));
      }
    });

    route('/dsh-l2d/workspace/status.json', async (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (!workspaceBridge) return sendBuffer(res, 503, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'dsh-workspace-services-unavailable' })));
      try {
        const result = await workspaceBridge.status();
        sendBuffer(res, result.ok ? 200 : 503, MIME['.json'], Buffer.from(JSON.stringify(result), 'utf8'));
      } catch (err) {
        sendBuffer(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'workspace-status-failed', hint: String(err?.message || err) }), 'utf8'));
      }
    });

    route('/dsh-l2d/agent-state.json', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const enabled = readSettings().agentLink !== false;
      const data = enabled ? getAgentState() : { ok: false, state: 'idle', reason: 'disabled' };
      sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(data), 'utf8'));
    });

    // 系统硬件采样（Emotion_Router 的 system 信号源）。
    // CPU 用 /proc 式采样：两次 os.cpus() 时间差；内存用 freemem/totalmem。
    // 开销极低（每 5s 由前端轮询一次），但仍受 systemSensor 开关约束。
    let cpuSample = null;
    route('/dsh-l2d/sys-metrics.json', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (readSettings().systemSensor !== true) {
        return sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'disabled' }), 'utf8'));
      }
      let idle = 0;
      let total = 0;
      try {
        for (const c of os.cpus()) {
          for (const k of Object.keys(c.times)) total += c.times[k];
          idle += c.times.idle;
        }
      } catch {
        /* ignore */
      }
      let cpu = null;
      if (cpuSample && total > cpuSample.total) {
        const dTotal = total - cpuSample.total;
        const dIdle = idle - cpuSample.idle;
        if (dTotal > 0) cpu = Math.min(1, Math.max(0, 1 - dIdle / dTotal));
      }
      cpuSample = { idle, total };
      let mem = null;
      try {
        mem = 1 - os.freemem() / os.totalmem();
      } catch {
        /* ignore */
      }
      const body = { ok: true, cpu, mem, ts: Date.now() };
      sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(body), 'utf8'));
    });

    route('/dsh-l2d/settings.json', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));

      if (req.method === 'PUT' || req.method === 'POST') {
        if (!isLoopback(req)) {
          return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('loopback only'));
        }
        const chunks = [];
        req.on('data', (c) => {
          chunks.push(c);
          if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) req.destroy();
        });
        req.on('end', () => {
          let patch = {};
          try {
            patch = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};
          } catch {
            return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad json'));
          }
          if (patch.clearApiKey === true) patch.apiKey = '';
          // apiKey 传空字符串视为「不修改」，避免前端回写时把已存的 key 冲掉
          if (patch.apiKey === '') delete patch.apiKey;
          delete patch.clearApiKey;
          const saved = writeSettings(patch);
          balanceCache.ts = 0; // 让下一次查询立即生效
          const view = {
            scale: saved.scale,
            soundEnabled: saved.soundEnabled,
            soundVolume: saved.soundVolume,
            refreshSeconds: saved.refreshSeconds,
            eyeFollow: saved.eyeFollow !== false,
            agentLink: saved.agentLink !== false,
            clickMode: saved.clickMode === 'api' ? 'api' : 'random',
            spontaneousChat: saved.spontaneousChat !== false,
            memeStyle: saved.memeStyle !== false,
            memeLevel: Math.min(100, Math.max(0, Number(saved.memeLevel) || 0)),
            autoAct: saved.autoAct !== false,
            systemSensor: saved.systemSensor === true,
            mediaSensor: saved.mediaSensor === true,
            petWindow: saved.petWindow === 'only' ? 'only' : 'off',
            reverseEnabled: saved.reverseEnabled !== false,
            petMode: saved.petMode !== false,
            hasApiKey: !!String(saved.apiKey || '').trim(),
          };
          sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(view), 'utf8'));
        });
        return;
      }

      const st = readSettings();
      const view = {
        scale: st.scale,
        soundEnabled: st.soundEnabled,
        soundVolume: st.soundVolume,
        refreshSeconds: st.refreshSeconds,
        eyeFollow: st.eyeFollow !== false,
        agentLink: st.agentLink !== false,
        clickMode: st.clickMode === 'api' ? 'api' : 'random',
        spontaneousChat: st.spontaneousChat !== false,
        memeStyle: st.memeStyle !== false,
        memeLevel: Math.min(100, Math.max(0, Number(st.memeLevel) || 0)),
        autoAct: st.autoAct !== false,
        systemSensor: st.systemSensor === true,
        mediaSensor: st.mediaSensor === true,
        petWindow: st.petWindow === 'only' ? 'only' : 'off',
        reverseEnabled: st.reverseEnabled !== false,
        petMode: st.petMode !== false,
        hasApiKey: !!String(st.apiKey || '').trim(),
      };
      sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(view), 'utf8'));
    });

    // ---------------------------------------------------------------- 人设（L1）
    // GET 读当前人设；PUT/POST 接受局部 patch（或 {reset:true}）。
    // 读侧不缓存：规划层每次组装上下文都重新读文件，所以「改完下一次规划立即生效」。
    route('/dsh-l2d/persona.json', async (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method === 'GET') {
        let persona;
        try {
          persona = readPersona();
        } catch (err) {
          diag('persona 读取失败: ' + String(err && err.message ? err.message : err));
          return sendBuffer(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'read-failed' }), 'utf8'));
        }
        return sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, persona }), 'utf8'));
      }
      if (req.method !== 'PUT' && req.method !== 'POST') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET or PUT'));
      }
      if (!isLoopback(req)) {
        return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('loopback only'));
      }
      let body = {};
      try {
        body = await readJsonBody(req, 32 * 1024);
      } catch {
        return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad json'));
      }
      try {
        const patch = body && body.patch && typeof body.patch === 'object' ? body.patch : body || {};
        const persona = body && body.reset === true ? resetPersona() : writePersona(patch);
        sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, persona }), 'utf8'));
      } catch (err) {
        diag('persona 写入失败: ' + String(err && err.message ? err.message : err));
        sendBuffer(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'write-failed' }), 'utf8'));
      }
    });

    route('/dsh-l2d/audio/index.json', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const files = listAudio();
      sendBuffer(
        res,
        200,
        MIME['.json'],
        Buffer.from(JSON.stringify({ dir: AUDIO_DIR, files }), 'utf8'),
      );
    });

    route('/dsh-l2d/audio/file', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      let name = '';
      try {
        name = new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || '';
      } catch {
        name = '';
      }
      // 只允许取 AUDIO_DIR 下白名单内的文件名，杜绝路径穿越
      if (!name || name !== path.basename(name) || !listAudio().includes(name)) {
        return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found'));
      }
      const buf = readIfExists(path.join(AUDIO_DIR, name));
      if (!buf) return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found'));
      const ext = path.extname(name).toLowerCase();
      const type =
        ext === '.mp3'
          ? 'audio/mpeg'
          : ext === '.wav'
            ? 'audio/wav'
            : ext === '.ogg'
              ? 'audio/ogg'
              : 'audio/mp4';
      sendBuffer(res, 200, type, buf);
    });

    route('/dsh-l2d/config.json', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      // 只下发前端需要的非敏感项，apiKey 绝不出网
      const st = readSettings();
      const payload = {
        scale: st.scale,
        soundEnabled: st.soundEnabled,
        soundVolume: st.soundVolume,
        refreshSeconds: st.refreshSeconds,
        eyeFollow: st.eyeFollow !== false,
        agentLink: st.agentLink !== false,
        clickMode: st.clickMode === 'api' ? 'api' : 'random',
        spontaneousChat: st.spontaneousChat !== false,
        memeStyle: st.memeStyle !== false,
        memeLevel: Math.min(100, Math.max(0, Number(st.memeLevel) || 0)),
        autoAct: st.autoAct !== false,
        systemSensor: st.systemSensor === true,
        mediaSensor: st.mediaSensor === true,
        petWindow: st.petWindow === 'only' ? 'only' : 'off',
        reverseEnabled: st.reverseEnabled !== false,
        petMode: st.petMode !== false,
        hasApiKey: !!String(st.apiKey || '').trim(),
      };
      sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(payload), 'utf8'));
    });

    // ------------------------------------------------------ 桌宠独立窗（petWindow: 'only'）
    // 探针/建窗/穿透/拖动都在 lib/pet-window.mjs；默认 'off' 时零开销直接返回 null。
    // 异步启动：若启动完成前插件被卸载，petClosed 先置位，迟到的 dispose 会被立即调用。
    const petStops = [];
    let petClosed = false;
    void setupPetWindow({
      settings: readSettings(),
      preloadPath: PET_PRELOAD_FILE,
      getOrigin: () => {
        try {
          if (ctx.webServer && typeof ctx.webServer.getOrigin === 'function') return ctx.webServer.getOrigin();
          if (ctx.webServer && ctx.webServer.port) return `http://127.0.0.1:${ctx.webServer.port}`;
        } catch {
          /* ignore */
        }
        return null;
      },
      diag,
    })
      .then((stop) => {
        if (petClosed) {
          if (typeof stop === 'function') {
            try {
              stop();
            } catch {
              /* ignore */
            }
          }
          return;
        }
        if (typeof stop === 'function') petStops.push(stop);
      })
      .catch((err) => diag('pet 窗: 启动异常 ' + String(err && err.message ? err.message : err)));

    try {
      ctx.effect(() => () => {
        petClosed = true;
        for (const d of disposers) {
          try {
            d();
          } catch {
            /* ignore */
          }
        }
        for (const s of petStops) {
          try {
            s();
          } catch {
            /* ignore */
          }
        }
      });
    } catch {
      /* effect 不可用时忽略，进程退出时路由自然释放 */
    }

    console.log(`[dsh-l2d] 已挂载：/dsh-l2d/overlay.js（立绘：${AVATAR_CANDIDATES[0]}）`);
  });

  // Workspace / Session services are optional in some DSH profiles.
  // Keep the existing overlay operational when those services are absent.
  // L1：桥每次 refresh 都经 getPersona() 重读人设文件（无缓存），改完下一次规划立即生效；
  // 通知上下文另含用户交互态（env 状态文件，>30s 过期按 unknown）与工具真实回执。
  root.inject(['workspaceRegistry', 'sessionController', 'agentPresets'], (ctx) => {
    const bridge = createWorkspaceAgentBridge({
      ctx,
      homeDir: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      getSnapshot: () => getWorkspaceAgentStates(ctx.workspaceRegistry),
      getPersona: () => readPersona(),
      intervalMs: 4000,
    });
    workspaceBridge = bridge;
    bridge.ensure().catch((err) => diag('Workspace Agent 初始化失败: ' + String(err?.message || err)));
    try {
      ctx.effect(() => () => {
        bridge.dispose();
        if (workspaceBridge === bridge) workspaceBridge = null;
      });
    } catch {
      /* Host shutdown also releases the interval. */
    }
  });
}
