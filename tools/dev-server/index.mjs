/**
 * DSH-L2D 独立开发服务器（零依赖）
 *
 * 目的：不依赖 DeepSeek Harness Desktop，直接用浏览器验证 Live2D 渲染。
 * 与 DSH 插件里那套路由保持同样的路径语义，便于两边行为一致：
 *
 *   /                → 调试页（public/index.html）
 *   /core.js         → Cubism Core
 *   /renderer.js     → 渲染包（packages/dsh-l2d-plugin/assets/renderer.js）
 *   /model/<相对路径> → 模型目录静态文件
 *
 * 用法：
 *   node tools/dev-server/index.mjs [--port 5300]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAiInbox } from '../../packages/dsh-l2d-plugin/lib/ai-inbox.mjs';
import {
  readMotionMode,
  writeMotionMode,
  listNodegraphs,
  saveNodegraph,
  loadNodegraph,
  runNodegraph,
  createInboxActExecutor,
} from '../../packages/dsh-l2d-plugin/lib/nodegraph.mjs';
import { createRunRegistry } from '../../packages/dsh-l2d-plugin/lib/nodegraph-runs.mjs';
import { guardGraphCall } from '../../packages/dsh-l2d-plugin/lib/host-guard.mjs';
import { createModelImporter, readBodyBuffer } from '../../packages/dsh-l2d-plugin/lib/model-import.mjs';
import { deepseekChatJson, resolveDeepSeekKey } from '../../packages/dsh-l2d-plugin/lib/llm-channel.mjs';
import {
  handleApplyOps,
  handleAiEdit,
  handleGraphGet,
  handleCatalog,
  NODEGRAPH_API_BODY_LIMIT,
} from '../../packages/dsh-l2d-plugin/lib/nodegraph-api.mjs';
import { handleAiPlan } from '../../packages/dsh-l2d-plugin/lib/nodegraph-planner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const PORT = Number(argOf('--port') || process.env.PORT || 5300);
// 默认仅回环；公网/局域网部署用 DSH_HOST=0.0.0.0 显式放开
const HOST = process.env.DSH_HOST || '127.0.0.1';

const MODEL_DIR =
  process.env.DSH_L2D_MODEL_DIR || path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek');
const CORE_FILE =
  process.env.DSH_L2D_CORE ||
  path.join(ROOT, 'vendor', 'cubism', 'CubismSdkForWeb-5-r.5', 'Core', 'live2dcubismcore.min.js');
const RENDERER_FILE = path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'assets', 'renderer.js');
const PUBLIC_DIR = path.join(HERE, 'public');

// 模型 zip 导入管线：与真机宿主 lib/index.js 同规格（同一份 lib/model-import.mjs）。
// 测试/本地可用 DSH_L2D_IMPORT_SCAN_OUT 把能力画像产物引到临时目录，避免污染仓库。
const modelImporter = createModelImporter({
  modelDir: MODEL_DIR,
  repoRoot: ROOT,
  ...(process.env.DSH_L2D_IMPORT_SCAN_OUT ? { scanOutDir: process.env.DSH_L2D_IMPORT_SCAN_OUT } : {}),
});

// MG-LAB Control Studio 静态页：严格显式白名单，只有这两条 URL 可达。
// 刻意不开 assets/*.html 通用映射——URL 一旦参与文件名拼接就有目录穿越风险；
// 这里 value 是预先拼好的绝对路径，req.url 只作 Map 查找键，不参与 path.join。
// 与真机宿主 lib/index.js 保持同一组路径语义。
const STUDIO_HTML_ROUTES = new Map([
  ['/motion-graph.html', path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'assets', 'motion-graph.html')],
  ['/control-studio.html', path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'assets', 'control-studio.html')],
  // MG-LAB 监看窗口数据源：与真机宿主 /dsh-l2d/pet.html 同语义（lib/pet.html）
  ['/pet.html', path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'lib', 'pet.html')],
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.moc3': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

/**
 * 动作库只读查询（DEV-ACTION-API）。validated + compatible=1 + 当前模型锚定，
 * 供 overlay 用真实动作库替代「只读 model3.json Motion 组」的随机池。
 * 动态 import node:sqlite：宿主 Node <22.5 或 sqlite 不可用时降级空集，不影响服务器启动。
 */
const ACTIONS_DB_FILE = path.join(ROOT, 'data', 'bootstrap-state.sqlite');
const ACTIONS_MODEL_ID = process.env.DSH_L2D_ACTIONS_MODEL_ID || '大肥鱼.dsl2d';
async function queryValidatedActions() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(ACTIONS_DB_FILE, { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT c.id AS chainId, d.id AS motionId, d.semantic_key AS semanticKey,
                  d.emotion AS emotion, c.chain_json AS chainJson, b.adapter_json AS adapterJson
           FROM action_chains c
           JOIN motion_definitions d ON d.id = c.motion_id
           JOIN motion_model_bindings b ON b.motion_id = d.id
           WHERE d.status = 'validated' AND b.compatible = 1 AND b.model_id = ?
           ORDER BY d.semantic_key`
        )
        .all(ACTIONS_MODEL_ID);
    } finally {
      db.close();
    }
  } catch {
    return []; // 库缺失/损坏/无 sqlite → 空集（预期：当前 2 条 validated；tail-sway-happy 为 draft 会被过滤）
  }
}

function send(res, status, type, buf, cors = true) {
  const headers = {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  };
  // 写路由不带 CORS 头：跨站 JS 写完也读不到响应，配合 writeGuard 的 Origin 校验。
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  res.writeHead(status, headers);
  res.end(buf);
}

// 写方法防护：浏览器发起的跨站写会带 Origin 头，非同源一律 403。
// 非浏览器客户端（curl/Agent）无 Origin 不受影响；部署到非回环 host 时用实际 host 比对，同样兼容。
function writeGuard(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let same = false;
  try { same = new URL(String(origin)).host === String(req.headers.host || ''); } catch { same = false; }
  if (!same) {
    send(res, 403, 'text/plain; charset=utf-8', Buffer.from('cross-origin write blocked'), false);
    return false;
  }
  return true;
}

// JSON body 读取：统一 16KB 上限（超限直接断开），所有 POST/PUT 路由必须走这里。
const BODY_LIMIT = 16 * 1024;
function readJsonBody(req, res, onBody) {
  const chunks = [];
  let total = 0;
  req.on('data', (c) => {
    total += c.length;
    if (total > BODY_LIMIT) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};
    } catch {
      return send(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad json'), false);
    }
    onBody(body);
  });
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/** 把 URL 路径安全地映射到目录下的文件，拒绝穿越 */
function resolveInside(baseDir, relRaw) {
  let rel = relRaw;
  try {
    rel = decodeURIComponent(relRaw);
  } catch {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (!rel || rel.includes('..') || rel.includes('\0')) return null;
  const full = path.resolve(baseDir, rel);
  const rootAbs = path.resolve(baseDir);
  if (!full.startsWith(rootAbs + path.sep) && full !== rootAbs) return null;
  return full;
}

/** AI 指令队列：与 DSH 插件宿主共用 ai-inbox，回执语义保持一致 */
const aiInbox = createAiInbox();

// 节点图执行入口（SPEC §4 第 4 行）的单批下发回调：与插件宿主同一份实现
//（nodegraph.createInboxActExecutor），走本进程 aiInbox 的 l2d_act 下发链路；
// 无 renderer 时按 forward 语义超时回 {ok:false, reason:'timeout', id}，不挂起不崩溃。
const nodegraphExecutor = createInboxActExecutor({
  call: (name, args) => aiInbox.call(name, args),
  read: (id) => aiInbox.read(id),
});

// NE-02 执行注册表（与真机宿主 index.js 同语义）：executionId / 同图 busy / 批间取消 / 历史回查
const nodegraphRuns = createRunRegistry({ maxRecords: 20 });
const randomUUID = () => crypto.randomUUID();
const AI_ALLOWED = new Set([
  'l2d_set_expression',
  'l2d_play_motion',
  'l2d_look_at',
  'l2d_set_parameters',
  'l2d_reset_pose',
  'l2d_play_keyframes',
  'l2d_stop_keyframes',
  'l2d_set_pose',
  'l2d_emote',
  'l2d_gaze',
  'l2d_say',
  'l2d_act',
  'l2d_get_state',
  'l2d_reset',
  'l2d_cue',
  'l2d_cue_stop',
]);

// 内存态设置（模拟 DSH 侧的 settings 持久化，重启 server 会重置）
const memSettings = {
  apiKey: '',
  refreshSeconds: 60,
  soundEnabled: true,
  soundVolume: 0.7,
  scale: 1,
  eyeFollow: true,
  agentLink: true,
  clickMode: 'random',
  spontaneousChat: true,
  memeStyle: true,
  memeLevel: 50,
  autoAct: true,
  petMode: true,
};
// 可通过 /settings.json 修改的键（白名单，防原型污染/任意键注入）
const SETTING_KEYS = new Set(Object.keys(memSettings));

function settingsView() {
  return {
    scale: memSettings.scale,
    soundEnabled: memSettings.soundEnabled,
    soundVolume: memSettings.soundVolume,
    refreshSeconds: memSettings.refreshSeconds,
    eyeFollow: memSettings.eyeFollow !== false,
    agentLink: memSettings.agentLink !== false,
    clickMode: memSettings.clickMode === 'api' ? 'api' : 'random',
    spontaneousChat: memSettings.spontaneousChat !== false,
    memeStyle: memSettings.memeStyle !== false,
    memeLevel: Math.min(100, Math.max(0, Number(memSettings.memeLevel) || 0)),
    autoAct: memSettings.autoAct !== false,
    petMode: memSettings.petMode !== false, // 与插件宿主同语义：默认开，显式 false 才关
    petWindow: 'off',
    reverseEnabled: true,
    hasApiKey: !!String(memSettings.apiKey || '').trim(),
  };
}

const server = http.createServer(async (req, res) => {
  let urlPath = String(req.url || '/').split('?')[0];

  // 让 overlay.js 可以被原样加载：它请求的是 /dsh-l2d/* 前缀，
  // 这里剥离前缀后复用同一套路由，等于在本地复刻了插件环境。
  if (urlPath.startsWith('/dsh-l2d/')) {
    urlPath = urlPath.slice('/dsh-l2d'.length);
  }

  // 首页
  if (urlPath === '/' || urlPath === '/index.html') {
    const buf = readIfExists(path.join(PUBLIC_DIR, 'index.html'));
    if (!buf) return send(res, 500, 'text/plain; charset=utf-8', Buffer.from('public/index.html 缺失'));
    return send(res, 200, MIME['.html'], buf);
  }

  // Companion Workspace（stage-web 构建产物，UIUX 改造后入口）
  if (urlPath === '/workspace' || urlPath === '/workspace.html') {
    const buf = readIfExists(
      path.join(HERE, '..', '..', 'apps', 'stage-web', 'dist', 'index.html'),
    );
    if (!buf) {
      return send(
        res,
        404,
        'text/plain; charset=utf-8',
        Buffer.from('workspace 未构建：pnpm -F @dsh/stage-web build'),
      );
    }
    // dist 内资源引用是根绝对路径 /assets/...，改写到 /workspace-assets/ 下
    return send(
      res,
      200,
      MIME['.html'],
      Buffer.from(buf.toString('utf8').replaceAll('/assets/', '/workspace-assets/')),
    );
  }
  if (urlPath.startsWith('/workspace-assets/')) {
    const full = resolveInside(
      path.join(HERE, '..', '..', 'apps', 'stage-web', 'dist', 'assets'),
      urlPath.slice('/workspace-assets/'.length),
    );
    if (!full) return send(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad path'));
    const buf = readIfExists(full);
    if (!buf) return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found'));
    const ext = path.extname(full).toLowerCase();
    return send(res, 200, MIME[ext] || 'application/octet-stream', buf);
  }

  // Cubism Core
  if (urlPath === '/core.js') {
    const buf = readIfExists(CORE_FILE);
    if (!buf) {
      return send(
        res,
        404,
        'text/plain; charset=utf-8',
        Buffer.from('Cubism Core 缺失：' + CORE_FILE),
      );
    }
    return send(res, 200, MIME['.js'], buf);
  }

  // 渲染包
  if (urlPath === '/renderer.js') {
    const buf = readIfExists(RENDERER_FILE);
    if (!buf) {
      return send(
        res,
        404,
        'text/plain; charset=utf-8',
        Buffer.from('renderer.js 未构建：pnpm -F @dsh/renderer build'),
      );
    }
    return send(res, 200, MIME['.js'], buf);
  }

  // 模型（含贴图 / moc3 / model3.json）。
  // MODEL-404-ROOTCAUSE 实证：/dsh-l2d/model 前缀已在上方剥离（:222-225），
  // overlay.js:2357 的 MODEL_URL（/dsh-l2d/model/…编码文件名）经剥前缀 +
  // resolveInside 内部 decodeURIComponent 后正确命中本路由——dev-server 与真机
  // 插件路由（lib/index.js:1322）行为一致，合成页 404 是无静态服务的环境假象。
  if (urlPath.startsWith('/model/')) {
    const full = resolveInside(MODEL_DIR, urlPath.slice('/model/'.length));
    if (!full) return send(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad path'));
    const buf = readIfExists(full);
    if (!buf) {
      return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found: ' + urlPath));
    }
    const ext = path.extname(full).toLowerCase();
    return send(res, 200, MIME[ext] || 'application/octet-stream', buf);
  }

  // ---- overlay.js 依赖的宿主接口（本地版，语义与插件一致）
  if (urlPath === '/settings.json') {
    if (req.method === 'PUT' || req.method === 'POST') {
      if (!writeGuard(req, res)) return;
      return readJsonBody(req, res, (body) => {
        const patch = { ...body };
        if (patch.clearApiKey === true) patch.apiKey = '';
        if (patch.apiKey === '') delete patch.apiKey;
        delete patch.clearApiKey;
        // 白名单拷贝：直接 Object.assign 会连 "__proto__" / "constructor" 一起吃下（原型污染）。
        for (const key of Object.keys(patch)) {
          if (SETTING_KEYS.has(key)) memSettings[key] = patch[key];
        }
        return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(settingsView()), 'utf8'));
      });
    }
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(settingsView()), 'utf8'));
  }

  if (urlPath === '/config.json') {
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(settingsView()), 'utf8'));
  }

  // ---- 真机宿主同语义路由（accept E/F 的契约锚点，dev-server 对齐后可本地全绿）----
  // GET /dsh-l2d/settings → assets/settings.html（五分区标题，accept-E）
  if (urlPath === '/settings') {
    const buf = readIfExists(
      path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'assets', 'settings.html'),
    );
    if (!buf) return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('settings.html missing'));
    return send(res, 200, MIME['.html'], buf);
  }

  // MG-LAB：/dsh-l2d/motion-graph.html 与 /dsh-l2d/control-studio.html、/dsh-l2d/pet.html（监看）
  // （前缀已在 :242 剥离）。仅命中上面白名单 Map 的精确路径，其余仍走末尾 404。
  if (STUDIO_HTML_ROUTES.has(urlPath)) {
    const buf = readIfExists(STUDIO_HTML_ROUTES.get(urlPath));
    if (!buf) {
      return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('studio page missing: ' + urlPath));
    }
    return send(res, 200, MIME['.html'], buf);
  }

  // GET /dsh-l2d/capability.json → 能力画像（accept-F 契约：modelId + controls）
  // 数据源 = capability-scan 产物，与真机宿主同一份，杜绝 dev-server 伪造画像。
  const CAPABILITY_FILE = path.join(
    ROOT,
    'tools',
    'capability-scan',
    `profile.${process.env.DSH_L2D_ACTIONS_MODEL_ID || '大肥鱼.dsl2d.2048'}.json`,
  );
  if (urlPath === '/capability.json') {
    const buf = readIfExists(CAPABILITY_FILE);
    if (!buf) {
      return send(
        res,
        404,
        'text/plain; charset=utf-8',
        Buffer.from('capability profile 缺失：先跑 pnpm scan:capability'),
      );
    }
    return send(res, 200, MIME['.json'], buf);
  }

  // POST /dsh-l2d/capability/rescan → 重读画像文件（重建缓存语义，不驱动角色）。
  // dev-server 无宿主内存画像缓存，重读 = 本地环境下等价的缓存重建；
  // 真正的扫描重建由 pnpm scan:capability 完成（宿主侧 rescan 语义见插件宿主路由）。
  if (urlPath === '/capability/rescan') {
    if (req.method !== 'POST') {
      return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
    }
    if (!writeGuard(req, res)) return;
    const buf = readIfExists(CAPABILITY_FILE);
    if (!buf) {
      return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('capability profile 缺失'));
    }
    const body = {
      ok: true,
      note: 'dev-server 画像缓存已重建（重读 capability-scan 产物）',
      modelId: JSON.parse(buf.toString('utf8')).modelId || null,
    };
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(body), 'utf8'));
  }

  if (urlPath === '/balance.json') {
    const body = { ok: false, reason: 'no-key', hint: '本地调试台未配置 API Key' };
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(body), 'utf8'));
  }

  // 本地调试台返回 idle；真实 DSH 插件会解析 session.v4.jsonl.zstd
  if (urlPath === '/agent-state.json') {
    const body = memSettings.agentLink === false
      ? { ok: false, state: 'idle', reason: 'disabled' }
      : { ok: true, state: 'idle', workspace: 'dev-server', ageMs: 999999 };
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(body), 'utf8'));
  }

  // 本地不真正调用 DeepSeek：让前端走随机动作兜底
  if (urlPath === '/ai-action.json') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
    if (!writeGuard(req, res)) return;
    const body = { ok: false, reason: 'no-key' };
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(body), 'utf8'));
  }

  if (urlPath === '/audio/index.json') {
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ files: [] }), 'utf8'));
  }

  if (urlPath === '/status.json') {
    const body = { ok: true, version: '0.1.0-local', mode: 'dev-server' };
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(body), 'utf8'));
  }

  if (urlPath === '/overlay-test.html') {
    const buf = readIfExists(path.join(PUBLIC_DIR, 'overlay-test.html'));
    if (!buf) return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('overlay-test.html missing'));
    // [accept C/D] 注入构建标记 ?v=<启动时间戳>：真机宿主以同样方式在 overlay.js
    // 的 script src 上带 v=（overlay.js 从 document.currentScript.src 解析为
    // diag.bootTag）。裸加载时 bootTag='' → 数字 0 < MIN_BOOT_TAG → accept 判
    // 「旧实例，回执不可信」记 WARN。这里对齐真机注入语义，本地验收可真 PASS。
    const html = buf
      .toString('utf8')
      .replace(
        'src="/dsh-l2d/overlay.js"',
        `src="/dsh-l2d/overlay.js?v=${Date.now()}"`,
      );
    return send(res, 200, MIME['.html'], Buffer.from(html, 'utf8'));
  }

  // host-sim.html（UI4：宿主侧边栏模拟页，验证 settings-entry 菜单直达节点编辑器）
  if (urlPath === '/host-sim.html') {
    const buf = readIfExists(path.join(PUBLIC_DIR, 'host-sim.html'));
    if (!buf) return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('host-sim.html missing'));
    return send(res, 200, MIME['.html'], buf);
  }

  // AI 指令：外部 Agent 通过这里驱动角色
  if (urlPath === '/ai/call') {
    if (req.method !== 'POST') {
      return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
    }
    if (!writeGuard(req, res)) return;
    return readJsonBody(req, res, (body) => {
      const name = String(body.name || '').trim();
      if (!AI_ALLOWED.has(name)) {
        return send(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown tool: ' + name));
      }
      const queued = aiInbox.call(name, body.args || {});
      return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(queued), 'utf8'));
    });
  }

  if (urlPath === '/ai/poll') {
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(aiInbox.poll()), 'utf8'));
  }

  if (urlPath === '/ai/result') {
    if (req.method === 'GET') {
      const id = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('id'));
      return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(aiInbox.read(id)), 'utf8'));
    }
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
    if (!writeGuard(req, res)) return;
    return readJsonBody(req, res, (body) => {
      const saved = aiInbox.post(body);
      if (!saved.ok) {
        return send(res, 400, 'text/plain; charset=utf-8', Buffer.from(saved.reason || 'id required'), false);
      }
      return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true }), 'utf8'));
    });
  }

  // ---------------------- AI 节点编辑（docs/nodegraph/AI-EDIT-API.md） ----------------------
  // 与插件路由同语义，处理器共用 lib/nodegraph-api.mjs。dev-server 没有插件设置，
  // LLM Key 只认环境变量 DEEPSEEK_API_KEY；没有则 ai-edit 返回 503 ai-unavailable。
  // 模型目录清单接口（按模型动作链）：catalog?model=X 不传则用当前模型（目录第一个 model3.json）。
  if (urlPath === '/api/nodegraph/catalog') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'), false);
    let modelParam;
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.searchParams.has('model')) modelParam = String(u.searchParams.get('model'));
    } catch {
      modelParam = undefined;
    }
    const currentModelId = (() => {
      try {
        const f = fs.readdirSync(MODEL_DIR).find((n) => n.endsWith('.model3.json'));
        return f ? f.slice(0, -'.model3.json'.length) : '';
      } catch {
        return '';
      }
    })();
    const out = handleCatalog(modelParam, { modelId: currentModelId });
    return send(res, out.status, MIME['.json'], Buffer.from(JSON.stringify(out.payload), 'utf8'));
  }
  if (urlPath === '/api/nodegraph/apply-ops' || urlPath === '/api/nodegraph/ai-edit' || urlPath === '/api/nodegraph/ai-plan') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'), false);
    if (!writeGuard(req, res)) return;
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > NODEGRAPH_API_BODY_LIMIT) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      const reply = (out) => send(res, out.status, MIME['.json'], Buffer.from(JSON.stringify(out.payload), 'utf8'), false);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply({ status: 400, payload: { ok: false, reason: 'invalid-request', message: 'body 不是合法 JSON' } });
      }
      try {
        if (urlPath === '/api/nodegraph/apply-ops') return reply(handleApplyOps(body));
        const key = resolveDeepSeekKey({});
        const llm = key
          ? (prompt) => deepseekChatJson({ key, ...prompt, temperature: 0.2, maxTokens: 2000, timeoutMs: 30000 })
          : null;
        if (urlPath === '/api/nodegraph/ai-plan') {
          // 与 catalog 分支同源的当前模型推导（模型根顶层第一个 model3.json）
          const currentModelId = (() => {
            try {
              const f = fs.readdirSync(MODEL_DIR).find((n) => n.endsWith('.model3.json'));
              return f ? f.slice(0, -'.model3.json'.length) : '';
            } catch {
              return '';
            }
          })();
          return reply(await handleAiPlan(body, { llm, getCurrentModelId: () => currentModelId }));
        }
        return reply(await handleAiEdit(body, { llm }));
      } catch {
        return reply({ status: 500, payload: { ok: false, reason: 'internal-error' } });
      }
    });
    return;
  }

  if (urlPath === '/api/nodegraph/graph') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'), false);
    let name = '';
    let listModel = '';
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      name = String(u.searchParams.get('name') || '');
      listModel = String(u.searchParams.get('model') || '');
    } catch {
      name = '';
    }
    const out = handleGraphGet(name, { listModel: listModel || undefined });
    return send(res, out.status, MIME['.json'], Buffer.from(JSON.stringify(out.payload), 'utf8'));
  }

  // ---------------------- 节点图动作编排通道（docs/nodegraph/SPEC.md §4） ----------------------
  // 与插件路由同语义；$DSH_HOME 同源解析（nodegraph.mjs 内部）。
  if (urlPath === '/nodegraphs') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'), false);
    try {
      const listed = listNodegraphs();
      return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(listed), 'utf8'));
    } catch (err) {
      return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({
        ok: false,
        items: [],
        errors: [String((err && err.message) || err)],
      }), 'utf8'));
    }
  }

  if (urlPath === '/nodegraphs/import') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'), false);
    if (!writeGuard(req, res)) return;
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 256 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      let doc;
      try {
        doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['body 不是合法 JSON'] }), 'utf8'));
      }
      // 与真机宿主同级：路由入口过 guardGraphCall（HOST_GRAPH_TOOLS：l2d_nodegraph_import）
      const importGuard = guardGraphCall({ name: 'l2d_nodegraph_import', args: { doc } });
      if (!importGuard.ok) {
        return send(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: importGuard.reason, errors: [importGuard.message] }), 'utf8'));
      }
      try {
        const saved = saveNodegraph(doc);
        if (!saved.ok) {
          return send(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: saved.errors }), 'utf8'));
        }
        return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, name: saved.name }), 'utf8'));
      } catch (err) {
        return send(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: [String((err && err.message) || err)] }), 'utf8'));
      }
    });
    return;
  }

  if (urlPath === '/nodegraphs/export') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'), false);
    let name = '';
    try {
      name = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || '');
    } catch {
      name = '';
    }
    if (!name) {
      return send(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['name required'] }), 'utf8'));
    }
    const raw = loadNodegraph(name);
    if (raw === null) {
      return send(res, 404, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['nodegraph not found: ' + name] }), 'utf8'));
    }
    return send(res, 200, MIME['.json'], Buffer.from(raw, 'utf8'));
  }

  // 节点图执行入口（SPEC §4 第 4 行，14:50 定案）。与插件宿主同语义：
  // runNodegraph 内部兜互斥另一半（llm 模式 409 mode-blocked）；POST 走 writeGuard。
  // 无 renderer 消费时 execute 按 forward 语义在预算内超时，返回明确错误不挂起。
  if (urlPath === '/nodegraphs/run') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'), false);
    if (!writeGuard(req, res)) return;
    let name = '';
    try {
      name = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || '');
    } catch {
      name = '';
    }
    if (!name) {
      return send(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['name required'] }), 'utf8'));
    }
    // 与真机宿主同级：路由入口过 guardGraphCall（HOST_GRAPH_TOOLS：l2d_nodegraph_run）
    const runGuard = guardGraphCall({ name: 'l2d_nodegraph_run', args: { name } });
    if (!runGuard.ok) {
      return send(res, runGuard.status || 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: runGuard.reason, errors: [runGuard.message] }), 'utf8'));
    }
    // NE-02：同图重入防护（与真机宿主同语义）
    const executionId = randomUUID();
    const begun = nodegraphRuns.begin(executionId, name);
    if (!begun.ok) {
      return send(res, 409, MIME['.json'], Buffer.from(JSON.stringify({
        ok: false, reason: 'busy', executionId: begun.executionId,
        message: '该节点图已在执行中',
      }), 'utf8'));
    }
    // 取消传播：每批下发前检查 cancelRequested（批间粒度，已入队批次播完）
    const cancellableExecutor = async (input) => {
      const rec = nodegraphRuns.get(executionId);
      if (rec && rec.cancelRequested) {
        return { ok: false, accepted: false, reason: 'cancelled' };
      }
      return nodegraphExecutor(input);
    };
    try {
      const result = await runNodegraph(name, cancellableExecutor);
      const httpStatus = result && result.ok === false && typeof result.status === 'number' ? result.status : 200;
      nodegraphRuns.finish(executionId, { ...result, executionId });
      return send(res, httpStatus, MIME['.json'], Buffer.from(JSON.stringify({ ...result, executionId }), 'utf8'));
    } catch (err) {
      nodegraphRuns.finish(executionId, { ok: false, status: 'failed', reason: 'execution-error' });
      return send(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: [String((err && err.message) || err)], executionId }), 'utf8'));
    }
  }

  // NE-02：执行历史回查（GET）与取消（POST），防护与 run 同级
  if (urlPath === '/nodegraphs/executions') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'), false);
    let id = '';
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      id = u.searchParams.get('id') || '';
      const limit = Number(u.searchParams.get('limit')) || 20;
      if (id) {
        // 与真机宿主同级：?id 回查过 guardGraphCall（HOST_GRAPH_TOOLS：l2d_nodegraph_status）
        const statusGuard = guardGraphCall({ name: 'l2d_nodegraph_status', args: { executionId: id } });
        if (!statusGuard.ok) {
          return send(res, statusGuard.status || 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: statusGuard.reason, errors: [statusGuard.message] }), 'utf8'));
        }
        const rec = nodegraphRuns.get(id);
        if (!rec) return send(res, 404, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'not-found' }), 'utf8'));
        return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, record: rec }), 'utf8'));
      }
      return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, items: nodegraphRuns.list({ limit }) }), 'utf8'));
    } catch (err) {
      return send(res, 500, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: [String((err && err.message) || err)] }), 'utf8'));
    }
  }

  if (urlPath === '/nodegraphs/cancel') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'), false);
    if (!writeGuard(req, res)) return;
    let id = '';
    try {
      id = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || '');
    } catch {
      id = '';
    }
    if (!id) return send(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: ['id required'] }), 'utf8'));
    // 与真机宿主同级：路由入口过 guardGraphCall（HOST_GRAPH_TOOLS：l2d_nodegraph_cancel）
    const cancelGuard = guardGraphCall({ name: 'l2d_nodegraph_cancel', args: { executionId: id } });
    if (!cancelGuard.ok) {
      return send(res, cancelGuard.status || 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: cancelGuard.reason, errors: [cancelGuard.message] }), 'utf8'));
    }
    const rec = nodegraphRuns.get(id);
    if (!rec || rec.status !== 'running') {
      return send(res, 404, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, reason: 'not-found-or-terminal' }), 'utf8'));
    }
    nodegraphRuns.requestCancel(id);
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, cancelled: true, executionId: id }), 'utf8'));
  }

  // ---------------------- 模型 zip 导入（与真机宿主同规格） ----------------------
  // POST /models/import：zip 原始字节（X-Filename URL 编码），同步校验后 202 {jobId}；
  // GET ?jobId=X：任务状态回查；POST /models/import/cancel：步骤边界取消。
  if (urlPath === '/models/import') {
    if (req.method === 'GET') {
      let jobId = '';
      try {
        jobId = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('jobId') || '');
      } catch {
        jobId = '';
      }
      if (!jobId) {
        return send(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, error: 'job-id-required', message: '缺少 jobId' }), 'utf8'));
      }
      const record = modelImporter.get(jobId);
      if (!record) {
        return send(res, 404, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, error: 'not-found', message: '导入任务不存在：' + jobId }), 'utf8'));
      }
      return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(record), 'utf8'));
    }
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST or GET'), false);
    if (!writeGuard(req, res)) return;
    try {
      const data = await readBodyBuffer(req, modelImporter.maxZipBytes);
      let filename = '';
      try {
        filename = decodeURIComponent(String(req.headers['x-filename'] || ''));
      } catch {
        filename = String(req.headers['x-filename'] || '');
      }
      const out = modelImporter.beginImport({ filename, data });
      if (out.ok) {
        return send(res, 202, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, jobId: out.jobId }), 'utf8'));
      }
      return send(res, out.status, MIME['.json'], Buffer.from(JSON.stringify({
        ok: false,
        error: out.reason,
        jobId: out.existingJobId,
        message: out.message,
      }), 'utf8'));
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const code = err && err.code ? err.code : 'import-failed';
      const message = err && err.message ? err.message : '导入受理失败';
      return send(res, status, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, error: code, message }), 'utf8'));
    }
  }

  if (urlPath === '/models/import/cancel') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'), false);
    if (!writeGuard(req, res)) return;
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 4 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};
      } catch {
        body = {};
      }
      const jobId = typeof body.jobId === 'string' ? body.jobId : '';
      if (!jobId) {
        return send(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, error: 'job-id-required', message: '缺少 jobId' }), 'utf8'));
      }
      const out = modelImporter.cancel(jobId);
      if (out.ok) {
        return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, cancelled: true, jobId }), 'utf8'));
      }
      if (out.error === 'not-found') {
        return send(res, 404, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, error: 'not-found', message: '导入任务不存在：' + jobId }), 'utf8'));
      }
      return send(res, 409, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, error: 'not-cancellable', state: out.state, message: '任务已结束（' + out.state + '），无需取消' }), 'utf8'));
    });
    return;
  }

  if (urlPath === '/motion-mode') {
    if (req.method === 'GET') {
      const state = readMotionMode();
      return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({
        ok: true,
        mode: state.mode,
        updatedAt: state.updatedAt,
        available: state.available,
      }), 'utf8'));
    }
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET or POST'), false);
    if (!writeGuard(req, res)) return;
    return readJsonBody(req, res, (body) => {
      try {
        const state = writeMotionMode(body.mode);
        return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({
          ok: true,
          mode: state.mode,
          updatedAt: state.updatedAt,
        }), 'utf8'));
      } catch (err) {
        return send(res, 400, MIME['.json'], Buffer.from(JSON.stringify({ ok: false, errors: [String((err && err.message) || err)] }), 'utf8'));
      }
    });
  }

  // 界面令牌。/dsh-l2d/ui-tokens.css 也会走到这里（上面已剥前缀）。
  if (urlPath === '/ui-tokens.css') {
    const buf = readIfExists(path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'assets', 'ui-tokens.css'));
    if (!buf) return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('ui-tokens.css missing'));
    return send(res, 200, MIME['.css'], buf);
  }

  // 悬浮层结构样式。/dsh-l2d/overlay.css 同样会走到这里（上面已剥前缀）。
  if (urlPath === '/overlay.css') {
    const buf = readIfExists(path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'assets', 'overlay.css'));
    if (!buf) return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('overlay.css missing'));
    return send(res, 200, MIME['.css'], buf);
  }

  // overlay.js（便于在纯浏览器里验证叠加层逻辑）
  if (urlPath === '/overlay.js') {
    const buf = readIfExists(path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'lib', 'overlay.js'));
    if (!buf) return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('overlay.js missing'));
    return send(res, 200, MIME['.js'], buf);
  }

  // settings-entry.js（UI4：便于在 host-sim 页里验证侧边栏菜单直达节点编辑器）
  if (urlPath === '/settings-entry.js') {
    const buf = readIfExists(path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'lib', 'settings-entry.js'));
    if (!buf) return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('settings-entry.js missing'));
    return send(res, 200, MIME['.js'], buf);
  }

  // 模型清单：给调试页自动列出可用的 model3.json
  if (urlPath === '/api/models') {
    let list = [];
    try {
      list = fs
        .readdirSync(MODEL_DIR)
        .filter((f) => f.endsWith('.model3.json'))
        .sort();
    } catch {
      list = [];
    }
    const body = Buffer.from(JSON.stringify({ dir: MODEL_DIR, models: list }), 'utf8');
    return send(res, 200, MIME['.json'], body);
  }

  // 动作库只读 API（DEV-ACTION-API）：overlay 前端消费 validated 动作链。
  // 只读纪律：DatabaseSync readOnly:true、仅 GET、每请求独立连接（写方是插件/导入进程，
  // WAL 下并发读安全）；库缺失/损坏/0 条一律 {ok:true, actions:[]}，前端静默降级不 500。
  if (urlPath === '/api/actions') {
    if (req.method !== 'GET') {
      return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use GET'));
    }
    const actions = await queryValidatedActions();
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true, actions }), 'utf8'));
  }

  // 桥动作队列状态（宿主经 globalThis.__DSH_ACTION_QUEUE__ 挂载 getState；未挂载如实上报 enabled:false）
  if (urlPath === '/action/queue') {
    const q = globalThis.__DSH_ACTION_QUEUE__;
    const state = q && typeof q.getState === 'function' ? { enabled: true, ...q.getState() } : { enabled: false };
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(state), 'utf8'));
  }

  // 诊断端点：区分 dev-server 与真机 bridge（谁在端口上一探便知）。
  // 真机宿主实现同名端点时返回自己的标识；无此端点的旧版宿主，任意应答也足以证明端口被占。
  if (urlPath === '/__dsh_l2d_health') {
    const body = {
      ok: true,
      server: 'dev-server',
      port: PORT,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
    };
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(body), 'utf8'));
  }

  send(res, 404, 'text/plain; charset=utf-8', Buffer.from('404 ' + urlPath));
});

// ---- 端口纪律（防抢占真机 bridge）----
// 5300 是全链路唯一约定端口：插件 client fallback（lib/index.js）、MCP 侧
// HttpActionExecutor baseUrl、dsh-l2d-mcp discover 全部打它。2026-11-06 事故：
// dev-server 长期驻留 5300 → 真机宿主 bridge 绑定失败/插件打到假宿主 → 模型加载
// 全链路失败。防线：启动前先探测，端口上有任何服务应答一律拒绝启动（--force 显式越过）。
function probeOccupied(port, host) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/__dsh_l2d_health', method: 'GET', timeout: 800 },
      (res) => {
        res.resume();
        resolve(true); // 任意 HTTP 应答 = 端口已被占用（不管对方是不是 DSH）
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false)); // ECONNREFUSED = 端口空闲
    req.end();
  });
}

const FORCE = process.argv.includes('--force');
const occupied = await probeOccupied(PORT, HOST);
if (occupied && !FORCE) {
  console.error('[dev-server] 拒绝启动：端口 ' + PORT + ' 已有服务在监听（疑似真机 DSH bridge）。');
  console.error('  抢占它会断掉插件 ↔ MCP 的整条动作链路。可选：');
  console.error('  1) 不起 dev-server，直接用真机实例；  2) --port 换端口；  3) --force 确认覆盖。');
  process.exit(1);
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[dev-server] 端口 ' + PORT + ' 被占用（EADDRINUSE）：真机 bridge 可能在运行，本进程退出，不抢占。');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log('[dev-server] http://' + HOST + ':' + PORT + '/');
  console.log('  模型目录: ' + MODEL_DIR);
  console.log('  Core    : ' + (readIfExists(CORE_FILE) ? 'OK' : '缺失'));
  console.log('  渲染包  : ' + (readIfExists(RENDERER_FILE) ? 'OK' : '缺失'));
});
