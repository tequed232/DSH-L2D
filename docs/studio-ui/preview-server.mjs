/**
 * 本轮视觉验收专用只读静态预览服务（零依赖，不改动任何现有源码）。
 * 用法：node docs/studio-ui/preview-server.mjs [--port 5400]
 * 映射：/dsh-l2d/<file> → packages/dsh-l2d-plugin/assets/<file>
 *       找不到时回退 → packages/dsh-l2d-plugin/lib/<file>
 *       /dsh-l2d/settings → assets/settings.html
 *       / → 可访问页面索引
 * 仅监听 127.0.0.1。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const assets = path.join(root, 'packages', 'dsh-l2d-plugin', 'assets');
const lib = path.join(root, 'packages', 'dsh-l2d-plugin', 'lib');
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : 5400);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
};

function readSafe(dir, rel) {
  const full = path.resolve(dir, '.' + path.sep + rel);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  try { return fs.readFileSync(full); } catch { return null; }
}

const pages = [
  ['/dsh-l2d/settings', '设置页（Control Studio 样式）'],
  ['/dsh-l2d/test.html', '参数监视台 / 渲染自检'],
  ['/dsh-l2d/pet.html', '独立宠物页'],
  ['/dsh-l2d/overlay-test.html', '浮层控件测试页'],
  ['/dsh-l2d/ui-tokens.css', '界面令牌'],
  ['/dsh-l2d/overlay.css', '浮层样式'],
  ['/dsh-l2d/overlay.js', '浮层运行时'],
];

http.createServer((req, res) => {
  let urlPath = String(req.url || '/').split('?')[0];
  if (urlPath === '/' || urlPath === '/index.html') {
    const list = pages.map(([u, d]) => `<li><a href="${u}">${u}</a> — ${d}</li>`).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>DSH-L2D 样式验收预览</title>
      <body style="font:14px/1.7 system-ui;background:#0d0f13;color:#e9ecf3;padding:32px">
      <h1>DSH-L2D Control Studio 样式验收预览</h1><ul>${list}</ul></body>`);
  }
  let rel = urlPath.replace(/^\/dsh-l2d\/?/, '');
  if (rel === 'settings' || rel === 'settings.html') rel = 'settings.html';
  if (rel === 'overlay-test.html') {
    const buf = readSafe(path.join(root, 'tools', 'dev-server', 'public'), 'overlay-test.html');
    if (buf) { res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(buf); }
  }
  let buf = readSafe(assets, rel) || readSafe(lib, rel);
  if (!buf) { res.writeHead(404); return res.end('not found: ' + rel); }
  const ext = path.extname(rel).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(buf);
}).listen(PORT, '127.0.0.1', () => {
  console.log('preview-server listening on http://127.0.0.1:' + PORT + '/');
});
