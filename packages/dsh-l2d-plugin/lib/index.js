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
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiInbox } from './ai-inbox.mjs';
import { createWorkspaceAgentBridge } from './workspace-agent.mjs';
import { createReverseLog } from './reverse-log.mjs';
import { normalizePresencePayload, readEnvState, writeEnvState } from './env-state.mjs';
import { createModelIndexCache, guardAiCall, discoverModelFiles } from './host-guard.mjs';
import {
  readMotionMode,
  writeMotionMode,
  listNodegraphs,
  saveNodegraph,
  loadNodegraph,
  runNodegraph,
  checkRunModelBinding,
  createInboxActExecutor,
} from './nodegraph.mjs';
import { createRunRegistry } from './nodegraph-runs.mjs';
import { deepseekChatJson, resolveDeepSeekKey } from './llm-channel.mjs';
import { handleApplyOps, handleAiEdit, handleCatalog, handleGraphGet, NODEGRAPH_API_BODY_LIMIT } from './nodegraph-api.mjs';
import { isReservedParam } from './param-guards.mjs';
import { allowedFromLive2dIds, isSafeModelId, loadLive2dIdsForModel } from './nodegraph-schema.mjs';
import { ensureModelNodegraphs } from './nodegraph-templates.mjs';
import { readPersona, resetPersona, writePersona } from './persona.mjs';
import { ageSummaryState, isActionTool, legacyAgentState, summarizeSession } from './session-events.mjs';
import { listSessionFiles, readSessionEvents } from './session-log.mjs';
import { analyzeContext } from './context-analyzer.mjs';
import { maybeRunStartupSkillsCheck } from './skills-toolchain.mjs';
import { createForegroundProcessCollector } from './foreground-process.mjs';
import { buildWorkspaceContextSnapshot } from './workspace-snapshot.mjs';
import { setupPetWindow } from './pet-window.mjs';
// BRIDGE-MOUNT（PR-A/B/C 总装接线）：三原则组件——工作区隔离 / 状态解耦 / 执行串行。
// 依赖注入纪律：mcp-bridge 不 import 宿主，反向由宿主在此装配（agentClient 本地
// 适配器 / db / executor baseUrl 均经构造注入）。
import { openDb } from '../../dsh-l2d-db/src/db.mjs';
import {
  insertRequest as insertBridgeRequest,
  markRunning as markBridgeRunning,
  markTerminal as markBridgeTerminal,
  findById as findBridgeRequest,
  findUnfinished as findUnfinishedBridgeRequests,
  markInterruptedAll as markInterruptedAllBridgeRequests,
} from '../../dsh-l2d-db/src/bridge-actions-repo.mjs';
import { Live2DMCPBridge } from '../../mcp-bridge/index.mjs';
import {
  Live2DWorkspaceManager,
  WorkBuddyWorkspaceRegistry,
  WorkBuddySessionController,
} from '../../mcp-bridge/workspace-manager.mjs';
import { StatusReporter } from '../../mcp-bridge/status-reporter.mjs';
import { HttpActionExecutor } from '../../mcp-bridge/action-executor.mjs';
import { ModelActionQueue } from '../../mcp-bridge/action-queue.mjs';
import { registerLive2DTools } from '../../mcp-bridge/mcp-tools.mjs';
import { createGallerySource } from '../../mcp-bridge/gallery-source.mjs';

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
const OVERLAY_CSS_FILE = path.join(PKG_ROOT, 'assets', 'overlay.css');
const SETTINGS_HTML_FILE = path.join(PKG_ROOT, 'assets', 'settings.html');
// MG-LAB Control Studio 静态页：路径常量在模块加载期拼好，请求 URL 不参与文件名构造。
const MOTION_GRAPH_HTML_FILE = path.join(PKG_ROOT, 'assets', 'motion-graph.html');
const CONTROL_STUDIO_HTML_FILE = path.join(PKG_ROOT, 'assets', 'control-studio.html');
const CAPABILITY_DIR = path.join(L2D_ROOT, 'tools', 'capability-scan');
const CAPABILITY_SCAN = path.join(CAPABILITY_DIR, 'scan.mjs');
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

/**
 * 注入行的脚本地址带版本参数。
 * 没有版本号时浏览器会复用旧 overlay.js：改完代码刷新页面，跑的仍是上一次的逻辑，
 * 表现为「服务端 md5 已经是新文件，页面行为却没变」——排查成本极高。
 * 版本取 overlay.js 的 mtime，改文件即换 URL。
 */
function overlayBuildTag() {
  // 取 overlay 与渲染包两者的最大 mtime：只重建渲染包时版本号也必须变，
  // 否则页面可能拿着旧的 data-dsh-l2d 脚本标记继续用旧逻辑。
  try {
    const a = fs.statSync(OVERLAY_FILE).mtimeMs;
    const b = fs.existsSync(RENDERER_FILE) ? fs.statSync(RENDERER_FILE).mtimeMs : 0;
    return String(Math.floor(Math.max(a, b)));
  } catch {
    return String(Date.now());
  }
}

function overlayInjectRow() {
  // 宿主原生支持 kind:'script-src'（渲染为静态 <script src>，由 HTML 解析器执行）。
  // 旧方案是内联加载器 IIFE 动态 createElement('script')——在真机宿主页面上实测
  // 动态加载不可靠（内联 settings-entry 同表执行成功而 overlay 不加载），改用静态标签。
  return {
    kind: 'script-src',
    placement: 'body',
    src: '/dsh-l2d/overlay.js?v=' + overlayBuildTag(),
  };
}

/**
 * 当前模型 ID（统一裁决 2026-11-10）：模型文件名去 .model3.json（如 大肥鱼.dsl2d.2048）。
 * 取目录里发现的第一个 .model3.json（discoverModelFiles 排序后取 [0]）；目录读不到 → ''。
 * 能力画像路由与节点图模型绑定校验共用这一处取法，不再各写一份。
 */
function getCurrentModelId() {
  try {
    const modelFile = discoverModelFiles(MODEL_DIR)[0];
    return modelFile ? modelFile.replace(/\.model3\.json$/, '') : '';
  } catch {
    return '';
  }
}

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
  clickMode: { type: 'string', default: 'nodegraph', description: '单击角色动作：nodegraph 节点图编排 / random 随机动作 / api DeepSeek 决定' },
  spontaneousChat: { type: 'boolean', default: true, description: '空闲/完成时让角色主动冒泡' },
  memeStyle: { type: 'boolean', default: true, description: '让动作/气泡带梗味人设' },
  memeLevel: { type: 'number', default: 50, description: '玩梗程度 0~100' },
  autoAct: { type: 'boolean', default: true, description: '空闲时让 API 定期编排小动作' },
  systemSensor: { type: 'boolean', default: false, description: '系统硬件监听（CPU/内存/电量/断网驱动表情），默认关' },
  mediaSensor: { type: 'boolean', default: false, description: '媒体律动（音乐节拍摇摆），默认关' },
  petWindow: { type: 'string', default: 'off', description: '桌宠独立窗：off 关闭（页内浮层）/ only 独立透明窗（页内浮层停用，重启生效）' },
  reverseEnabled: { type: 'boolean', default: true, description: '反向桥：模型交互事件回流宿主（l2d-reverse-state.json + /ai/poll 搭车）' },
  workspaceForeground: { type: 'boolean', default: false, description: '工作区快照：读取前台应用进程名（默认关；仅本机、不取标题/路径/内容）' },
  consumerLeaseEnabled: { type: 'boolean', default: false, description: '消费者租约：/ai/poll 单消费者接管 + /ai/result token fencing，默认关' },
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
      clickMode: z.string().default('nodegraph').description('单击角色动作：nodegraph 节点图编排 / random 随机动作 / api DeepSeek 决定').extra('volatile', true),
      spontaneousChat: z.boolean().default(true).description('空闲/完成时让角色主动冒泡').extra('volatile', true),
      memeStyle: z.boolean().default(true).description('让动作/气泡带梗味人设').extra('volatile', true),
      memeLevel: z.number().default(50).description('玩梗程度 0~100').extra('volatile', true),
      autoAct: z.boolean().default(true).description('空闲时让 API 定期编排小动作').extra('volatile', true),
      systemSensor: z.boolean().default(false).description('系统硬件监听（CPU/内存/电量/断网驱动表情），默认关').extra('volatile', true),
      mediaSensor: z.boolean().default(false).description('媒体律动（音乐节拍摇摆），默认关').extra('volatile', true),
      petWindow: z.string().default('off').description('桌宠独立窗：off 关闭（页内浮层）/ only 独立透明窗（页内浮层停用，重启生效）').extra('volatile', true),
      reverseEnabled: z.boolean().default(true).description('反向桥：模型交互事件回流宿主（l2d-reverse-state.json + /ai/poll 搭车）').extra('volatile', true),
      workspaceForeground: z.boolean().default(false).description('工作区快照：读取前台应用进程名（默认关；仅本机、不取标题/路径/内容）').extra('volatile', true),
      consumerLeaseEnabled: z.boolean().default(false).description('消费者租约：/ai/poll 单消费者接管 + /ai/result token fencing，默认关').extra('volatile', true),
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
// 会话日志读取统一走 session-log.mjs；事件分类/老化统一走 session-events.mjs
// （W1 起只有一套扫描，getAgentState 通过 legacyAgentState 保持原返回契约）。
const AGENT_STATE_TTL = 1500;
let agentStateCache = { ts: 0, data: null };

/** 旧 getAgentState 的返回形状（overlay /agent-state.json 契约），由统一扫描适配。 */
function deriveAgentState(events, ageMs, workspace) {
  const summary = summarizeSession(events);
  return legacyAgentState(summary, { ageMs, workspace });
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
      const read = readSessionEvents(latest.file);
      data = read.ok
        ? deriveAgentState(read.events, now - latest.mtimeMs, latest.workspace)
        : { ok: false, state: 'idle', reason: read.error || 'read-failed' };
    }
  } catch (err) {
    data = { ok: false, state: 'idle', reason: String(err && err.message ? err.message : err) };
  }
  agentStateCache = { ts: now, data };
  return data;
}

export { getAgentState };

let workspaceBridge = null;
// BRIDGE-MOUNT：MCP Bridge 与 StatusReporter 的模块级引用（后续路由/MCP 薄壳消费）。
let mcpBridge = null;
let mcpStatusReporter = null;
let mcpHeartbeatTimer = null;
// W1：在 webServer 注入闭包里初始化（那里才有前台采集器与路由），桥用它取最新快照。
let runtimeSnapshotBuilder = null;
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
        const read = readSessionEvents(entry.file);
        // 缓存「截至读取时」的汇总；每次调用再用 ageSummaryState 按 now 老化，
        // 避免 mtime 不变时把状态冻在缓存那一刻。
        const summary = read.ok ? summarizeSession(read.events, { now }) : null;
        cached = { mtimeMs: entry.mtimeMs, size: entry.size, summary, error: read.ok ? null : read.error };
        workspaceEventCache.set(id, cached);
      }
      const ageMs = Math.max(0, Math.round(now - entry.mtimeMs));
      const summary = cached.summary || {
        state: 'unknown',
        substate: null,
        lastEventAt: 0,
        lastTool: null,
        lastTurnEnd: null,
        lastAction: null,
        pendingTool: null,
        hasError: false,
      };
      const aged = summary.lastEventAt
        ? ageSummaryState(summary, { now })
        : { state: summary.state, substate: summary.substate || null };
      const pending = summary.pendingTool && isActionTool(summary.pendingTool.name)
        ? { name: summary.pendingTool.name, priority: 'NORMAL' }
        : null;
      sessions.push({
        sessionIndex: sessions.length + 1,
        state: aged.state,
        substate: aged.substate || null,
        ageMs,
        lastEventAt: summary.lastEventAt,
        hasError: aged.state === 'error',
        lastTool: summary.lastTool || null,
        lastTurnEnd: summary.lastTurnEnd || null,
        lastAction: summary.lastAction || null,
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

/** 口型禁区：AI 关键帧一律不得写，留给以后的音频口型链路（名单单源在 param-guards）。 */

function sanitizeKeyframeStep(step, allowedParams) {
  if (!step || !Array.isArray(step.tracks)) return null;
  const whitelist = Array.isArray(allowedParams) && allowedParams.length ? allowedParams : null;
  const tracks = [];
  for (const track of step.tracks.slice(0, 5)) {
    if (!track || typeof track.param !== 'string' || !Array.isArray(track.keys)) continue;
    if (isReservedParam(track.param)) continue;
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

  // 与 AI 节点编辑共用同一条 LLM 通道（lib/llm-channel.mjs），参数与抽取前一致。
  const raw = await deepseekChatJson({
    key,
    system,
    user,
    temperature: 1.1,
    maxTokens: 900,
    timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
  });
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

  // ⓪ Skills 工具链自检（用户要求）：每次宿主「首次打开」（apply）跑一次，
  // 检查 skills/ 目录与各 SKILL.md 的打开/可用状态；仅在发现异常时追加写
  // $DSH_HOME/l2d-skills-check.log。自检 fail-open，任何失败不影响宿主启动。
  try {
    maybeRunStartupSkillsCheck({});
  } catch {
    /* 自检失败不阻断启动 */
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
          const injected = row && (row.src === undefined ? row.text : row.src);
          if (typeof injected === 'string' && injected.indexOf('/dsh-l2d/overlay.js') >= 0) return; // 已推过，不重复
        }
        table.push(overlayInjectRow());
        // UI-FLOAT 特批（本席文件所有权例外，仅此一处注入注册）：全局设置入口。
        // lib/settings-entry.js 整体内联（无 src，不新增路由）；幂等标记 __DSH_SETTINGS_ENTRY__ 防重复。
        try {
          const entrySrc = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'settings-entry.js'), 'utf8');
          const entryDup = typeof table.some === 'function'
            && table.some((r) => r && typeof r.text === 'string' && r.text.indexOf('__DSH_SETTINGS_ENTRY__') >= 0);
          if (!entryDup) table.push({ kind: 'script', placement: 'body', text: entrySrc });
        } catch { /* 入口文件缺失不影响宿主 */ }
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

    // 模型导入自动初始化联动节点（语义模板 × live2d-ids.json 清单实例化）：
    // 插件 apply + 模型发现成功（getCurrentModelId 非空）时 ensure 一次语义节点图
    // （poke-response 等，strict 绑定当前模型，落 $DSH_HOME/l2d-nodegraphs/）。
    // 幂等：meta.templateVersion 相同跳过（保留手改）、更旧重生成（升级策略）、更新不降级。
    // fail-open：清单缺失全跳过、任何异常不影响宿主启动。
    try {
      const ensured = ensureModelNodegraphs(getCurrentModelId());
      if (ensured && ensured.ok) {
        const touched = [
          ...ensured.generated.map((n) => 'generated:' + n),
          ...ensured.regenerated.map((n) => 'regenerated:' + n),
          ...ensured.failed.map((f) => 'failed:' + f.name),
        ];
        diag('nodegraph-templates ensure: source=' + ensured.catalogSource +
          (touched.length ? ' ' + touched.join(' ') : ' all-unchanged') +
          (ensured.skipped.length ? ' skipped=' + ensured.skipped.map((s) => s.id).join(',') : ''));
      } else {
        diag('nodegraph-templates ensure skipped: ' + (ensured && ensured.reason));
      }
    } catch (err) {
      diag('nodegraph-templates ensure error: ' + String(err && err.message ? err.message : err));
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

    route('/dsh-l2d/overlay.css', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const buf = readIfExists(OVERLAY_CSS_FILE);
      if (!buf) return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('overlay.css missing'));
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
    // 消费者租约（M1-d3）：flag 按调用时读取（settings volatile，热切换零重启），
    // 不得在构造时烘焙。TTL/宽容期与 READY 文档 §1.1 一致。
    const aiInbox = createAiInbox({
      leaseTtlMs: 15000,
      legacyGraceMs: 30 * 60 * 1000,
      leaseEnabled: () => readSettings().consumerLeaseEnabled === true,
      diag,
    });
    const reverseLog = createReverseLog({ diag });
    // 模型索引（表情/动作组/物理输出表）只读缓存：/ai/call 不该每次都读磁盘。
    // 读不到时守卫 fail-open（物理输出判定放行），由渲染端兜底，绝不 500。
    const aiIndexCache = createModelIndexCache(MODEL_DIR);

    // 节点图执行入口（docs/nodegraph/SPEC.md §4 第 4 行）的单批下发回调：
    // 复用 aiInbox 的 l2d_act 既有下发链路（与 /ai/call 同一入口函数，不另开一套），
    // 回执经 shapeActReceipt 成 MCP 同一形状。不经过 guardAiCall——互斥门禁只管
    // /ai/call 的 LLM 入口，不拦节点通道自身（互斥由 runNodegraph 的 409 兜住另一半）。
    const nodegraphExecutor = createInboxActExecutor({
      call: (name, args) => aiInbox.call(name, args),
      read: (id) => aiInbox.read(id),
    });

    // W1：前台进程采集默认关（设置 workspaceForeground=true 才启动）；关闭即停并清空采样。
    const foregroundCollector = createForegroundProcessCollector({ intervalMs: 2000 });
    try {
      ctx.effect(() => () => foregroundCollector.stop());
    } catch {
      /* 老宿主没有 effect：定时器 unref，进程退出不受影响 */
    }

    /**
     * W1：构造一次工作区快照（只读）。路由与 workspace-agent 共用同一入口，
     * 保证「事实 / 推断 / 不可得」三段只有一份实现。
     */
    const buildRuntimeSnapshot = (options = {}) => {
      const now = Number(options.now) || Date.now();
      foregroundCollector.setEnabled(readSettings().workspaceForeground === true);
      const requested = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : '';
      const files = listSessionFiles();
      let entry = files[0] || null;
      if (requested) entry = files.find((file) => file.sessionId === requested) || null;
      const presence = readEnvState({ now });
      const foreground = foregroundCollector.get();
      const read = entry ? readSessionEvents(entry.file) : { ok: false, events: [], error: 'no-session' };
      const summary = read.ok ? summarizeSession(read.events, { now }) : null;
      const activity = analyzeContext({ summary, presence, foreground, now });
      const missingSession = requested && !entry;
      const unavailable = read.ok
        ? []
        : [{ path: missingSession ? 'sessionId' : 'session', reason: missingSession ? 'no-session' : 'session-unreadable' }];
      return buildWorkspaceContextSnapshot({
        sessionId: entry ? entry.sessionId : null,
        summary,
        presence,
        foreground,
        activity,
        now,
        unavailable,
      });
    };
    runtimeSnapshotBuilder = buildRuntimeSnapshot;

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
        // 工具入参守卫（纵深防御，见 docs/Embodied-Behavior.md §7 / docs/M1-D-Adapter-Spec.md）：
        // 未知工具名、口型参数、物理输出未 own、未索引表情/动作组在入队前就 400；
        // 模型索引读不到时守卫 fail-open（物理输出判定放行），渲染端仍会再拦一次。
        let guarded;
        try {
          guarded = guardAiCall({ name, args: body.args || {} }, {
            index: aiIndexCache.get(),
            // 节点图模式互斥（docs/nodegraph/SPEC.md §3）：mode 文件缺失/损坏时 readMotionMode
            // 回 'llm'，与现状行为一致；本地小文件同步读，无缓存一致性风险。
            mode: readMotionMode().mode,
          });
        } catch (err) {
          // 守卫自身异常不得影响指令通道：记录后放行，交给渲染端校验。
          diag('ai/call guard error: ' + String((err && err.message) || err));
          guarded = { ok: true, warnings: ['guard-error'] };
        }
        if (!guarded.ok) {
          return sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from(guarded.message));
        }
        const queued = aiInbox.call(name, body.args || {});
        // 守卫的降级告警不能静默丢：进 diag 日志，并随回执带出给调用方（MCP/调试脚本）。
        if (Array.isArray(guarded.warnings) && guarded.warnings.length) {
          diag('ai/call guard warning: ' + guarded.warnings.join(','));
          queued.warnings = guarded.warnings;
        }
        sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(queued), 'utf8'));
      });
    });

    route('/dsh-l2d/ai/poll', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      // 消费者身份：新 overlay 带 ?consumer=<页面自生成 id>（version 仅诊断）；旧 overlay 无参数 → 空队列降级
      let consumerId = '';
      try {
        consumerId = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('consumer') || '');
      } catch {
        consumerId = '';
      }
      // 搭车：把反向桥事件摘要一并带给页面，overlay 可并入 l2d_get_state
      const polled = aiInbox.poll({ consumerId });
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
          // fenced（token 校验失败/先到先得/宽容期拒绝）→ 409 Conflict；其余（id 缺失）→ 400
          const status = saved.reason === 'fenced' ? 409 : 400;
          return sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(saved.reason || 'id required'));
        }
        sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true }), 'utf8'));
      });
    });

    // ---------------------- 节点图动作编排通道（docs/nodegraph/SPEC.md §4） ----------------------
    // 分享图存取与模式互斥。与 /ai/call 同一守卫风格：跨站拒、方法限、body 上限断开。
    route('/dsh-l2d/nodegraphs', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'GET') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'));
      }
      try {
        const listed = listNodegraphs();
        sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(listed), 'utf8'));
      } catch (err) {
        // 读目录异常不 500：回空列表带 errors，前端可降级展示。
        sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({
          ok: false,
          items: [],
          errors: [String((err && err.message) || err)],
        }), 'utf8'));
      }
    });

    route('/dsh-l2d/nodegraphs/import', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'POST') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
      }
      // 分享 JSON 全文上传；256KB 上限（120 节点图的宽松裕量），超限直接断开。
      const chunks = [];
      req.on('data', (c) => {
        chunks.push(c);
        if (chunks.reduce((n, b) => n + b.length, 0) > 256 * 1024) req.destroy();
      });
      req.on('end', () => {
        let doc;
        try {
          doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return sendBuffer(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['body 不是合法 JSON'] }), 'utf8'));
        }
        try {
          // 新图默认 strict 绑定当前模型（2026-11-10 统一约定）：doc 完全没有 modelBinding
          // 字段时注入；旧图显式带 bindingMode:'any' → 原样保存，不自动迁移。
          if (doc && typeof doc === 'object' && !Array.isArray(doc) && doc.modelBinding === undefined) {
            const modelId = getCurrentModelId();
            doc.modelBinding = modelId
              ? { modelId, modelHash: '', bindingMode: 'strict' }
              : { bindingMode: 'any' };
          }
          // 按图绑定模型选清单：把「静态 ∪ 该模型 live2d-ids.json」注入整图校验，
          // 清单里有而静态名单没有的表情/动作组也能导入。
          let importAllowed = null;
          try {
            const bindingId = doc && doc.modelBinding && typeof doc.modelBinding.modelId === 'string' && isSafeModelId(doc.modelBinding.modelId)
              ? doc.modelBinding.modelId
              : getCurrentModelId();
            if (bindingId) importAllowed = allowedFromLive2dIds(loadLive2dIdsForModel(bindingId).ids);
          } catch {
            importAllowed = null; // 清单读取异常按无注入走（静态名单兜底）
          }
          // saveNodegraph 内部先整体校验后原子写：重名覆盖前校验，失败原文件不动（SPEC §4）。
          const saved = saveNodegraph(doc, { allowed: importAllowed });
          if (!saved.ok) {
            return sendBuffer(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: saved.errors }), 'utf8'));
          }
          sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, name: saved.name }), 'utf8'));
        } catch (err) {
          sendBuffer(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: [String((err && err.message) || err)] }), 'utf8'));
        }
      });
    });

    route('/dsh-l2d/nodegraphs/export', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'GET') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'));
      }
      let name = '';
      try {
        name = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || '');
      } catch {
        name = '';
      }
      if (!name) {
        return sendBuffer(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['name required'] }), 'utf8'));
      }
      const raw = loadNodegraph(name);
      if (raw === null) {
        return sendBuffer(res, 404, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['nodegraph not found: ' + name] }), 'utf8'));
      }
      // JSON 原文回发（分享用），不再重新序列化。
      sendBuffer(res, 200, MIME['.json'], Buffer.from(raw, 'utf8'));
    });

    route('/dsh-l2d/motion-mode', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method === 'GET') {
        const state = readMotionMode();
        return sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({
          ok: true,
          mode: state.mode,
          updatedAt: state.updatedAt,
          available: state.available,
        }), 'utf8'));
      }
      if (req.method !== 'POST') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET or POST'));
      }
      const chunks = [];
      req.on('data', (c) => {
        chunks.push(c);
        if (chunks.reduce((n, b) => n + b.length, 0) > 4 * 1024) req.destroy();
      });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};
        } catch {
          body = {};
        }
        try {
          const state = writeMotionMode(body.mode);
          sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({
            ok: true,
            mode: state.mode,
            updatedAt: state.updatedAt,
          }), 'utf8'));
        } catch (err) {
          sendBuffer(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: [String((err && err.message) || err)] }), 'utf8'));
        }
      });
    });

    // 节点图执行入口（SPEC §4 第 4 行，14:50 定案）：导入的图回传动作给模型。
    // 传输面与 /ai/call 同级防护（回环 + 跨站栅栏 + POST 限）；业务面不经过 guardAiCall，
    // 互斥由 runNodegraph 内部兜住另一半（llm 模式 409 mode-blocked）。
    // 执行注册表：每次 run 建 executionId 档（可回查/可取消），同图重入互斥按图隔离
    // ——同名图同时只允许一个 run（busy 409），不同图允许并行执行。
    const nodegraphRunRegistry = createRunRegistry();
    route('/dsh-l2d/nodegraphs/run', (req, res) => {
      if (!isRemoteLoopback(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('loopback only'));
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'POST') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
      }
      let name = '';
      try {
        name = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || '');
      } catch {
        name = '';
      }
      if (!name) {
        return sendBuffer(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['name required'] }), 'utf8'));
      }
      // 模型绑定闸门：strict 绑定模型 ≠ 当前模型 → 409 model-mismatch，一个动作都不发。
      // 检查必须在 nodegraphRunRegistry.begin 之前——失败时不建 running 档，注册表零污染。
      const gate = checkRunModelBinding(name, { currentModelId: getCurrentModelId() });
      if (!gate.ok) {
        return sendBuffer(res, gate.status || 409, MIME['.json'], Buffer.from(JSON.stringify({
          ok: false,
          reason: gate.reason || 'model-mismatch',
          expected: gate.expected,
          actual: gate.actual,
          message: `节点图 strict 绑定模型 ${gate.expected}，当前模型 ${gate.actual}，未执行任何动作`,
        }), 'utf8'));
      }
      const executionId = randomUUID();
      const begun = nodegraphRunRegistry.begin(executionId, name);
      if (!begun.ok) {
        // 同图重入：409 + 既有 executionId，前端可据此回查在执行的 run。
        return sendBuffer(res, 409, MIME['.json'], Buffer.from(JSON.stringify({
          ok: false,
          reason: 'busy',
          executionId: begun.executionId,
          message: '该节点图已在执行中',
        }), 'utf8'));
      }
      // 包装 executor：每批下发前检查取消标志；已请求取消 → 不下发该批。
      // 非 accepted 回执使 executeActionSequence 按 stopped 停止后续批次，取消即传播到执行链。
      const cancellableExecutor = async (input) => {
        const record = nodegraphRunRegistry.get(executionId);
        if (record && record.cancelRequested) {
          return { ok: false, accepted: false, reason: 'cancelled' };
        }
        return nodegraphExecutor(input);
      };
      (async () => {
        try {
          // currentModelId 传入执行层：any 模式绑定模型与当前模型不一致时结果附 warning。
          const result = await runNodegraph(name, cancellableExecutor, { currentModelId: getCurrentModelId() });
          nodegraphRunRegistry.finish(executionId, result);
          // runNodegraph 约定：ok:false 且 status 为数字 → 该数字即 HTTP 状态码；
          // 正常执行回 executeActionSequence 原样（含 receipts/completedSegments/remainingSegments），200。
          const httpStatus = result && result.ok === false && typeof result.status === 'number' ? result.status : 200;
          // 正常路径追加 executionId（不改既有字段），供取消/回查关联。
          sendBuffer(res, httpStatus, MIME['.json'], Buffer.from(JSON.stringify({ ...result, executionId }), 'utf8'));
        } catch (err) {
          nodegraphRunRegistry.finish(executionId, { ok: false, reason: 'route-exception', errors: [String((err && err.message) || err)] });
          sendBuffer(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: [String((err && err.message) || err)] }), 'utf8'));
        }
      })();
    });

    // 执行记录回查（只读）：?id=X → 完整记录（含 result/receipts 全文）；
    // 否则 ?limit=N → 最近 N 条摘要（缺省注册表上限 20）。
    route('/dsh-l2d/nodegraphs/executions', (req, res) => {
      if (!isRemoteLoopback(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('loopback only'));
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'GET') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'));
      }
      let id = '';
      let limit = '';
      try {
        const params = new URL(req.url, 'http://127.0.0.1').searchParams;
        id = String(params.get('id') || '');
        limit = String(params.get('limit') || '');
      } catch {
        id = '';
        limit = '';
      }
      if (id) {
        const record = nodegraphRunRegistry.get(id);
        if (!record) {
          return sendBuffer(res, 404, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['execution not found: ' + id] }), 'utf8'));
        }
        return sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, execution: record }), 'utf8'));
      }
      const parsedLimit = Number.parseInt(limit, 10);
      const items = nodegraphRunRegistry.list({ limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined });
      sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, items }), 'utf8'));
    });

    // 取消执行：置 cancelRequested 标志；正在执行的批次循环在下一批 execute 前感知并停止。
    // 仅对 running 记录生效；缺失/已终态 → 404（无正在执行的该次执行可取消）。
    route('/dsh-l2d/nodegraphs/cancel', (req, res) => {
      if (!isRemoteLoopback(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('loopback only'));
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'POST') {
        return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
      }
      let id = '';
      try {
        id = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || '');
      } catch {
        id = '';
      }
      if (!id) {
        return sendBuffer(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['id required'] }), 'utf8'));
      }
      if (!nodegraphRunRegistry.requestCancel(id)) {
        return sendBuffer(res, 404, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['running execution not found: ' + id] }), 'utf8'));
      }
      sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, cancelled: true, executionId: id }), 'utf8'));
    });

    // ---------------------- AI 节点编辑（docs/nodegraph/AI-EDIT-API.md） ----------------------
    // 处理逻辑全部在 lib/nodegraph-api.mjs（与 dev-server 共用）；这里只做跨站拒、方法限、body 上限。
    // ai-edit 复用 lib/llm-channel.mjs 的 DeepSeek 通道（与「戳一戳 API 决定动作」同一 Key 来源）；
    // 没有 Key 时 llm=null → 503 ai-unavailable，不伪造结果。
    const nodegraphApiSend = (res, out) => {
      sendBuffer(res, out.status, MIME['.json'], Buffer.from(JSON.stringify(out.payload), 'utf8'));
    };
    const nodegraphApiPost = (handler) => async (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'POST') return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
      let body;
      try {
        body = await readJsonBody(req, NODEGRAPH_API_BODY_LIMIT);
      } catch {
        return nodegraphApiSend(res, { status: 400, payload: { ok: false, reason: 'invalid-request', message: 'body 不是合法 JSON 或超过 256KB' } });
      }
      try {
        nodegraphApiSend(res, await handler(body));
      } catch (err) {
        diag('nodegraph api 异常: ' + String((err && err.message) || err));
        nodegraphApiSend(res, { status: 500, payload: { ok: false, reason: 'internal-error' } });
      }
    };
    route('/dsh-l2d/api/nodegraph/apply-ops', nodegraphApiPost((body) => handleApplyOps(body, { getCurrentModelId })));
    route('/dsh-l2d/api/nodegraph/ai-edit', nodegraphApiPost((body) => {
      const key = resolveDeepSeekKey(readSettings());
      const llm = key
        ? (prompt) => deepseekChatJson({ key, ...prompt, temperature: 0.2, maxTokens: 2000, timeoutMs: 30000 })
        : null;
      return handleAiEdit(body, { llm, getCurrentModelId });
    }));
    route('/dsh-l2d/api/nodegraph/graph', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'GET') return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'));
      let name = '';
      let model = '';
      try {
        const params = new URL(req.url, 'http://127.0.0.1').searchParams;
        name = String(params.get('name') || '');
        model = String(params.get('model') || '');
      } catch {
        name = '';
        model = '';
      }
      // 不带 name + ?model=X → 按模型过滤的图列表（strict 绑定该模型的图 + any 图标记）。
      nodegraphApiSend(res, handleGraphGet(name, { getCurrentModelId, ...(model ? { listModel: model } : {}) }));
    });
    // 模型目录接口（唯一入口，不另开 /models）：GET catalog?model=X → 该模型动作组/表情/参数/forms。
    // model 缺省用当前模型；模型缺清单回退全局并带 warning model-catalog-missing。
    route('/dsh-l2d/api/nodegraph/catalog', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (req.method !== 'GET') return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'));
      let model = '';
      try {
        model = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('model') || '');
      } catch {
        model = '';
      }
      nodegraphApiSend(res, handleCatalog(model, { getCurrentModelId }));
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
      if (!isRemoteLoopback(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('loopback only'));
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const avatar = AVATAR_CANDIDATES.find((p) => fs.existsSync(p)) || null;
      const body = JSON.stringify({
        version: '0.1.0-preview',
        modelDir: MODEL_DIR,
        avatarFound: !!avatar,
        avatar: avatar ? path.basename(avatar) : null,
        // 运行时资源就位情况：之前这里写死了一句「静态立绘预览」，Cubism 接入后已失真。
        renderer: fs.existsSync(RENDERER_FILE),
        core: fs.existsSync(CORE_FILE),
        // [#28] 不再写死大肥鱼名单：按 MODEL_DIR 实际发现的 .model3.json 报告当前模型
        // （排序后第一份与旧行为一致：2048 档排在无后缀版之前）。
        model: discoverModelFiles(MODEL_DIR)[0] || null,
        note: 'Cubism 5 Web SDK 运行时：渲染包 /dsh-l2d/renderer.js，Core /dsh-l2d/core.js，模型前缀 /dsh-l2d/model/',
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

    // 设置页（P1 呈现层）：独立的单页设置界面，五个分区共用 /settings.json 契约
    route('/dsh-l2d/settings', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      const buf = readIfExists(SETTINGS_HTML_FILE);
      if (!buf) return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('settings.html missing'));
      sendBuffer(res, 200, 'text/html; charset=utf-8', buf);
    });

    // MG-LAB Control Studio 两张静态页：严格两条 exact 白名单，禁止开放
    // assets/*.html 通配（URL 参与文件名拼接会有目录穿越风险）。与其他页面路由
    // 复用同一套 isCrossSite 同源门禁 + readIfExists + sendBuffer，末尾 404 兜底不变。
    for (const [routePath, htmlFile] of [
      ['/dsh-l2d/motion-graph.html', MOTION_GRAPH_HTML_FILE],
      ['/dsh-l2d/control-studio.html', CONTROL_STUDIO_HTML_FILE],
    ]) {
      route(routePath, (req, res) => {
        if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
        const buf = readIfExists(htmlFile);
        if (!buf) return sendBuffer(res, 404, 'text/html; charset=utf-8', Buffer.from('studio page missing'));
        sendBuffer(res, 200, 'text/html; charset=utf-8', buf);
      });
    }

    // 能力画像（E0）：扫描产物只读返回，供设置页与调试面板使用
    route('/dsh-l2d/capability.json', (req, res) => {
      if (!isRemoteLoopback(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('loopback only'));
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      let file = null;
      try {
        const profiles = fs
          .readdirSync(CAPABILITY_DIR)
          .filter((n) => /^profile\..+\.json$/.test(n))
          .sort();
        // [#28] 画像按当前模型选：profile.<modelId>.json（modelId = 模型文件名去掉
        // .model3.json，与 scan.mjs 的命名规则一致）。只做精确匹配——多模型混部时
        // 回退字母序第一份会把别的模型的画像当现状返回（错误画像驱动错误演出）。
        // 当前模型没有画像 → 404 no-profile，提示 rescan；仅当目录里发现不了
        // model3.json（目录不可读/为空）时才回退第一份，保持旧目录名下的旧行为。
        const currentId = getCurrentModelId();
        if (currentId) {
          const expected = 'profile.' + currentId + '.json';
          file = profiles.find((n) => n === expected) || null;
        } else {
          file = profiles[0] || null;
        }
      } catch {
        file = null;
      }
      if (!file) {
        return sendBuffer(
          res,
          404,
          'application/json; charset=utf-8',
          Buffer.from(JSON.stringify({ ok: false, reason: 'no-profile', hint: 'POST /dsh-l2d/capability/rescan' })),
        );
      }
      const buf = readIfExists(path.join(CAPABILITY_DIR, file));
      if (!buf) return sendBuffer(res, 500, 'text/plain; charset=utf-8', Buffer.from('profile unreadable'));
      sendBuffer(res, 200, MIME['.json'], buf);
    });

    // 能力重扫：只在本地回环可用；明确是用户动作，不自动跑
    route('/dsh-l2d/capability/rescan', (req, res) => {
      if (req.method !== 'POST') return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
      if (!isRemoteLoopback(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('loopback only'));
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      if (!fs.existsSync(CAPABILITY_SCAN)) {
        return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('scan.mjs missing'));
      }
      const child = spawn(process.execPath, [CAPABILITY_SCAN], { cwd: L2D_ROOT, windowsHide: true });
      let out = '';
      child.stdout.on('data', (c) => {
        out += String(c);
      });
      child.stderr.on('data', (c) => {
        out += String(c);
      });
      child.on('error', (err) => {
        sendBuffer(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: String(err && err.message) })));
      });
      child.on('close', (code) => {
        sendBuffer(
          res,
          code === 0 ? 200 : 500,
          MIME['.json'],
          Buffer.from(JSON.stringify({ ok: code === 0, code, out: out.slice(-1200) })),
        );
      });
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

    // ------------------------------------------------------ W1 工作区快照（只读）
    // 会话事实 + presence + 可选前台进程 + 分析器。缺会话/未上报/采集关都以
    // unavailable 返回 200；500 只留给本路由自身的内部异常。
    route('/dsh-l2d/workspace/snapshot.json', (req, res) => {
      if (isCrossSite(req)) return sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('forbidden'));
      try {
        if (readSettings().agentLink === false) {
          return sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'disabled' }), 'utf8'));
        }
        let requested = '';
        try {
          requested = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('session') || '').slice(0, 80);
        } catch {
          requested = '';
        }
        const snapshot = buildRuntimeSnapshot({ sessionId: requested });
        sendBuffer(res, 200, MIME['.json'], Buffer.from(JSON.stringify(snapshot), 'utf8'));
      } catch (err) {
        diag('workspace snapshot error: ' + String((err && err.message) || err));
        sendBuffer(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'snapshot-failed' }), 'utf8'));
      }
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

    // ③ MCP Bridge 挂载（BRIDGE-MOUNT）：Live2DMCPBridge + Live2DWorkspaceManager +
    //    StatusReporter + ModelActionQueue。fail-open：任何失败只 diag，不影响宿主启动。
    //    本地降级模式注明（不伪报）：DeepSeek Harness 宿主暂无 A2A 客户端
    //    （acquireWorkspace/createSession 注入接口见 workspace-manager.mjs 头注），
    //    装配 localAgentClient——workspace/session ID 稳定幂等落 bridge_workspaces 表；
    //    未来接真 A2A 仅替换此对象，桥与管理器零改动。initialize 是异步的，
    //    挂载即启动、完成时 diag，就绪前 l2d_action_* 经 enqueueAction 明确拒绝（不静默）。
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      fs.mkdirSync(home, { recursive: true });
      // ⚠ 修复（真机 diag 实据 'origin is not defined'）：origin 是上方独立 try 块内的
      // const（块级作用域），挂载段不可见——曾导致 executor 构造抛 ReferenceError、
      // bridge 从未 initialize（schema 建齐但 bridge_workspaces 0 行 / 无 status 文件）。
      // 此处自行解析同一来源，5300 兜底对齐 HttpActionExecutor 缺省。
      const bridgeOrigin =
        (typeof ctx.webServer.getOrigin === 'function' ? ctx.webServer.getOrigin() : '') ||
        (ctx.webServer.port ? `http://127.0.0.1:${ctx.webServer.port}` : '') ||
        'http://127.0.0.1:5300';
      const bridgeDb = openDb({ path: path.join(home, 'l2d-bridge.sqlite') });
      const localAgentClient = {
        async acquireWorkspace({ pluginId }) {
          return { workspaceId: `local-${String(pluginId || 'dsh-l2d')}` };
        },
        async createSession({ workspaceId, key }) {
          return { sessionId: `${workspaceId}:${String(key || 'session')}` };
        },
      };
      const registry = new WorkBuddyWorkspaceRegistry({ db: bridgeDb, agentClient: localAgentClient });
      const sessions = new WorkBuddySessionController({ db: bridgeDb, agentClient: localAgentClient });
      const workspaceManager = new Live2DWorkspaceManager({ registry, sessions });
      const executor = new HttpActionExecutor({
        baseUrl: bridgeOrigin,
        // 真实完成事件订阅（PR-D，issue #33）：ai-inbox 观察者——overlay 的 action-done
        // 回执 post 落账即推送，executor 订阅路径直接返回终态，免去 /ai/result 轮询延迟。
        // 订阅不可达 / 拒绝落账 / deadline（30s 兜底）→ resolve null，executor 自动落轮询
        // 降级（fail-closed：订阅只是延迟优化，完成判定不依赖它）。
        subscribeEvents: (callId, onEvent, opts) => aiInbox.subscribeCompletion(callId, onEvent, opts),
        // 释放宽限（PR-D release 降级路径 / ownership 残留复查用）：1000ms。
        // 取值依据：仅在降级路径生效（真实完成事件 + 出口干净时零等待），常规节拍不受影响；
        // Loop 动作 / 老渲染包等不齐事件的场景按队列动作秒级时长给 1s 收尾缓冲，
        // 既覆盖 ownership 释放延迟，也不显著拖慢串行队列（test 用 5ms 只是测试加速值）。
        releaseGraceMs: 1000,
      });
      // queue 的 repo 门面：bridge_actions 持久化（重启恢复 B17 / 幂等 B15 / 背压 32）。
      const queueRepo = {
        insertRequest: (request) => insertBridgeRequest(bridgeDb, request),
        markRunning: (requestId, startedAt) => markBridgeRunning(bridgeDb, requestId, startedAt),
        markTerminal: (requestId, state, opts) => markBridgeTerminal(bridgeDb, requestId, state, opts),
        findById: (requestId) => findBridgeRequest(bridgeDb, requestId),
        findUnfinished: () => findUnfinishedBridgeRequests(bridgeDb),
        markInterruptedAll: () => markInterruptedAllBridgeRequests(bridgeDb),
      };
      const queue = new ModelActionQueue({ executor, repo: queueRepo });
      mcpBridge = new Live2DMCPBridge({
        workspaceManager,
        pluginId: 'dsh-l2d',
        queue,
        executor,
        actionsRepo: { findById: (requestId) => findBridgeRequest(bridgeDb, requestId) },
      });
      mcpBridge
        .initialize()
        .then(() => {
          diag(`mcp bridge ready: workspace=${mcpBridge.workspace.id} control=${mcpBridge.workspace.controlSessionId}`);
          // StatusReporter（状态解耦）：60s 合规区间；source 读真实 agent 状态
          // （getAgentState → UiStatus 映射），sink 落 $DSH_HOME/l2d-status-report.json。
          // revision 取 agentStateCache.ts（缓存周期内稳定、数据刷新即前进——
          // 当前快照源无单调事件版本，这是真实语义而非伪版本）。
          // memoryRevision 恒 0 也是真实事实：记忆通道未接（injectControlContext wired:false）。
          mcpStatusReporter = new StatusReporter({
            workspaceId: mcpBridge.workspace.id,
            intervalMs: 60_000,
            source: {
              getLatest: async () => {
                const data = getAgentState();
                const state = String(data && data.state ? data.state : 'idle');
                const status = state === 'error' ? 'crashed'
                  : state.startsWith('waiting') ? 'waiting'
                    : state === 'working' || state === 'thinking' ? 'running'
                      : 'idle';
                return { status, message: data && data.reason ? String(data.reason) : undefined, updatedAt: Date.now(), revision: agentStateCache.ts || Date.now() };
              },
            },
            sink: {
              report: async (input) => {
                fs.writeFileSync(path.join(home, 'l2d-status-report.json'), JSON.stringify(input) + '\n', 'utf8');
              },
            },
            getQueueState: () => queue.getState(),
            getMemoryRevision: async () => 0,
          });
          mcpStatusReporter.start();

          // ⑤ 心跳（team-lead 批准，与 B06 裁决语义分离）：每 60s 无条件落盘
          //    l2d-bridge-heartbeat.json，区分「Bridge 没跑」（文件不存在）与
          //    「idle 静默」（文件存在 + initialized:true）。数据全部真实来源：
          //    lastState=getAgentState、initialized=mcpBridge.initialized。
          const bridgeStartedAt = Date.now();
          mcpHeartbeatTimer = setInterval(() => {
            try {
              const data = getAgentState();
              fs.writeFileSync(
                path.join(home, 'l2d-bridge-heartbeat.json'),
                JSON.stringify({
                  workspaceId: (mcpBridge && mcpBridge.workspace && mcpBridge.workspace.id) || null,
                  initialized: !!(mcpBridge && mcpBridge.initialized),
                  lastState: String(data && data.state ? data.state : 'idle'),
                  lastSampleAt: new Date().toISOString(),
                  uptimeMs: Date.now() - bridgeStartedAt,
                }) + '\n',
                'utf8',
              );
            } catch { /* 心跳失败不影响宿主 */ }
          }, 60_000);
          mcpHeartbeatTimer.unref && mcpHeartbeatTimer.unref();

          // ④ l2d_* 工具注册（BRIDGE-MOUNT 第二步）：makeActionToolDeps 提供
          //    enqueue/status/cancel/workspace，validateAction 为语义动作合法性闸门
          //    （validated + compatible=1，与 /api/actions 同口径）；gallery 注入
          //    GallerySource（GALLERY-BRIDGE §4.3：图库目录读图 + 2MB/魔数护栏），
          //    注册后 l2d_gallery_top 可用（未就绪前不注册，不伪报可用）。
          //    registry 为宿主进程内注册表：MCP 薄壳（packages/dsh-l2d-mcp）经
          //    l2d-service.json discover 到宿主后消费同一工具面。
          try {
            const toolRegistry = new Map();
            const validateAction = (action) => {
              try {
                const row = bridgeDb
                  .prepare(
                    "SELECT m.id FROM motion_definitions m JOIN motion_model_bindings b ON b.motion_id = m.id " +
                    "WHERE m.semantic_key = ? AND m.status = 'validated' AND b.compatible = 1",
                  )
                  .get(String(action || ''));
                return { ok: !!row, reason: row ? 'validated+compatible' : 'not-registered-or-not-validated' };
              } catch (e) {
                return { ok: false, reason: String(e && e.message ? e.message : e) };
              }
            };
            const galleryDir = process.env.DSH_L2D_GALLERY_DIR || 'D:/Temp/l2d-gallery-extract';
            const gallery = createGallerySource({ db: bridgeDb, galleryDir });
            registerLive2DTools(
              { registerTool: (name, handler) => toolRegistry.set(name, handler) },
              { ...mcpBridge.makeActionToolDeps(validateAction), gallery },
            );
            diag(`l2d tools registered: ${[...toolRegistry.keys()].join(', ')}`);
          } catch (err) {
            diag('l2d tools 注册失败（fail-open，动作通道仍经 bridge.enqueueAction 可用）: ' + String(err && err.message ? err.message : err));
          }
        })
        .catch((err) => diag('mcp bridge 初始化失败（fail-open，不影响宿主）: ' + String(err && err.message ? err.message : err)));
      try {
        ctx.effect(() => () => {
          try { if (mcpStatusReporter) mcpStatusReporter.stop(); } catch { /* ignore */ }
          try { if (mcpBridge) void mcpBridge.dispose(); } catch { /* ignore */ }
          try { bridgeDb.close(); } catch { /* ignore */ }
          mcpStatusReporter = null;
          try { if (mcpHeartbeatTimer) clearInterval(mcpHeartbeatTimer); } catch { /* ignore */ }
          mcpHeartbeatTimer = null;
          mcpBridge = null;
        });
      } catch {
        /* effect 不可用时忽略，进程退出时资源自然释放 */
      }
    } catch (err) {
      diag('mcp bridge 挂载失败（fail-open，不影响宿主）: ' + String(err && err.message ? err.message : err));
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
      // 规划上下文用「结构化事实 + 推断 + 不可得」三段，不含会话正文。
      getWorkspaceSnapshot: () => (typeof runtimeSnapshotBuilder === 'function' ? runtimeSnapshotBuilder() : null),
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
