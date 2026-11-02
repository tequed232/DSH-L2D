/**
 * 寻找本机 DSH-L2D 的 HTTP 根地址。
 * 顺序：DSH_L2D_URL → ~/.dsh 里出现过的端口 → 本地调试服 5300。
 * 只接受回环地址，不把控制面指到外网。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isLoopbackUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/** 从一段文本里抽出看起来像端口的数字。 */
export function extractPorts(text) {
  const found = new Set();
  const patterns = [
    /(?:port|PORT|listen|Listen)["'\s:=]+(\d{2,5})/g,
    /127\.0\.0\.1:(\d{2,5})/g,
    /localhost:(\d{2,5})/g,
  ];
  for (const pattern of patterns) {
    for (const match of String(text || '').matchAll(pattern)) {
      const port = Number(match[1]);
      if (port >= 1024 && port <= 65535) found.add(port);
    }
  }
  return [...found];
}

function walkFiles(dir, depth, acc) {
  if (depth > 3 || acc.length > 200) return acc;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length > 200) break;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, depth + 1, acc);
    else if (/\.(json|txt|log|yml|yaml|toml|cfg|conf)$/i.test(entry.name) || entry.name === 'port') {
      acc.push(full);
    }
  }
  return acc;
}

export function portsFromDshHome(homeDir = path.join(os.homedir(), '.dsh')) {
  const ports = [];
  for (const file of walkFiles(homeDir, 0, [])) {
    let text = '';
    try {
      const stat = fs.statSync(file);
      if (stat.size > 512 * 1024) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const port of extractPorts(text)) ports.push(port);
  }
  return [...new Set(ports)];
}

export function candidateBases(env = process.env) {
  const list = [];
  const explicit = String(env.DSH_L2D_URL || '').trim();
  if (explicit) list.push(explicit.replace(/\/$/, ''));
  for (const port of portsFromDshHome()) {
    list.push(`http://127.0.0.1:${port}`);
  }
  list.push('http://127.0.0.1:5300');
  const seen = new Set();
  return list.filter((item) => {
    if (!isLoopbackUrl(item) || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

export async function probeBase(base, fetchImpl = globalThis.fetch, timeoutMs = 700) {
  const url = base.replace(/\/$/, '') + '/dsh-l2d/status.json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, cache: 'no-store' });
    return !!(res && res.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveBase(env = process.env) {
  for (const base of candidateBases(env)) {
    if (await probeBase(base)) return base;
  }
  return '';
}
