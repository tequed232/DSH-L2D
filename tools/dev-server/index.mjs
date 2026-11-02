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
import { fileURLToPath } from 'node:url';
import { createAiInbox } from '../../packages/dsh-l2d-plugin/lib/ai-inbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const PORT = Number(argOf('--port') || process.env.PORT || 5300);
const HOST = '127.0.0.1';

const MODEL_DIR =
  process.env.DSH_L2D_MODEL_DIR || path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek');
const CORE_FILE =
  process.env.DSH_L2D_CORE ||
  path.join(ROOT, 'vendor', 'cubism', 'CubismSdkForWeb-5-r.5', 'Core', 'live2dcubismcore.min.js');
const RENDERER_FILE = path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'assets', 'renderer.js');
const PUBLIC_DIR = path.join(HERE, 'public');

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

function send(res, status, type, buf) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
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
]);

// 内存态设置（模拟 DSH 侧的 settings 持久化，重启 server 会重置）
const memSettings = {
  apiKey: '',
  refreshSeconds: 60,
  soundEnabled: true,
  soundVolume: 0.7,
  scale: 1,
  eyeFollow: false,
  agentLink: true,
  clickMode: 'random',
  spontaneousChat: true,
  memeStyle: true,
  memeLevel: 50,
  autoAct: true,
  petMode: true,
};

function settingsView() {
  return {
    scale: memSettings.scale,
    soundEnabled: memSettings.soundEnabled,
    soundVolume: memSettings.soundVolume,
    refreshSeconds: memSettings.refreshSeconds,
    eyeFollow: memSettings.eyeFollow,
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

const server = http.createServer((req, res) => {
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

  // 模型（含贴图 / moc3 / model3.json）
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
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let patch = {};
        try {
          patch = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};
        } catch {
          return send(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad json'));
        }
        if (patch.clearApiKey === true) patch.apiKey = '';
        if (patch.apiKey === '') delete patch.apiKey;
        delete patch.clearApiKey;
        Object.assign(memSettings, patch);
        return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(settingsView()), 'utf8'));
      });
      return;
    }
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(settingsView()), 'utf8'));
  }

  if (urlPath === '/config.json') {
    return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(settingsView()), 'utf8'));
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
    return send(res, 200, MIME['.html'], buf);
  }

  // AI 指令：外部 Agent 通过这里驱动角色
  if (urlPath === '/ai/call') {
    if (req.method !== 'POST') {
      return send(res, 405, 'text/plain; charset=utf-8', Buffer.from('use POST'));
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
        return send(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad json'));
      }
      const name = String(body.name || '').trim();
      if (!AI_ALLOWED.has(name)) {
        return send(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown tool: ' + name));
      }
      const queued = aiInbox.call(name, body.args || {});
      return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify(queued), 'utf8'));
    });
    return;
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
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};
      } catch {
        return send(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad json'));
      }
      const saved = aiInbox.post(body);
      if (!saved.ok) {
        return send(res, 400, 'text/plain; charset=utf-8', Buffer.from(saved.reason || 'id required'));
      }
      return send(res, 200, MIME['.json'], Buffer.from(JSON.stringify({ ok: true }), 'utf8'));
    });
    return;
  }

  // 界面令牌。/dsh-l2d/ui-tokens.css 也会走到这里（上面已剥前缀）。
  if (urlPath === '/ui-tokens.css') {
    const buf = readIfExists(path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'assets', 'ui-tokens.css'));
    if (!buf) return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('ui-tokens.css missing'));
    return send(res, 200, MIME['.css'], buf);
  }

  // overlay.js（便于在纯浏览器里验证叠加层逻辑）
  if (urlPath === '/overlay.js') {
    const buf = readIfExists(path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'lib', 'overlay.js'));
    if (!buf) return send(res, 404, 'text/plain; charset=utf-8', Buffer.from('overlay.js missing'));
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

  send(res, 404, 'text/plain; charset=utf-8', Buffer.from('404 ' + urlPath));
});

server.listen(PORT, HOST, () => {
  console.log('[dev-server] http://' + HOST + ':' + PORT + '/');
  console.log('  模型目录: ' + MODEL_DIR);
  console.log('  Core    : ' + (readIfExists(CORE_FILE) ? 'OK' : '缺失'));
  console.log('  渲染包  : ' + (readIfExists(RENDERER_FILE) ? 'OK' : '缺失'));
});
