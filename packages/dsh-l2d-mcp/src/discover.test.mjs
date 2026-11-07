import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dshHome, extractPorts, isLoopbackUrl, candidateBases } from './discover.mjs';

assert.deepEqual(extractPorts('listen 5300\n"port": 4310\nhttp://127.0.0.1:8787/x'), [5300, 4310, 8787]);
assert.equal(isLoopbackUrl('http://127.0.0.1:5300'), true);
assert.equal(isLoopbackUrl('http://example.com:5300'), false);
const bases = candidateBases({ DSH_L2D_URL: 'http://8.8.8.8:9' });
assert.equal(bases.includes('http://8.8.8.8:9'), false);
assert.equal(bases.includes('http://127.0.0.1:5300'), true);

// #30：标准 IPv6 回环写法（WHATWG URL hostname 带方括号）不得被拒绝
assert.equal(isLoopbackUrl('http://[::1]:42137'), true);
assert.equal(isLoopbackUrl('http://[::1]'), true);
assert.equal(isLoopbackUrl('http://[::1]:42137/'.toUpperCase()), true); // 大小写不敏感

// #30：DSH_HOME 与宿主/插件共用同一解析规则；未设置时落 ~/.dsh
assert.equal(dshHome({}), path.join(os.homedir(), '.dsh'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-discover-'));
assert.equal(dshHome({ DSH_HOME: tmp }), tmp);

// 自定义 DSH_HOME 下的会合点必须进入候选列表（此前默认仍扫 ~/.dsh，列表里没有该地址）
fs.writeFileSync(path.join(tmp, 'l2d-service.json'), JSON.stringify({ origin: 'http://127.0.0.1:42137' }));
const basesHome = candidateBases({ DSH_HOME: tmp });
assert.ok(basesHome.includes('http://127.0.0.1:42137'), `候选列表缺自定义 DSH_HOME 会合点: ${basesHome.join(',')}`);
// 显式 URL 优先级保留：排在会合点之前
const basesExplicit = candidateBases({ DSH_HOME: tmp, DSH_L2D_URL: 'http://127.0.0.1:42139' });
assert.equal(basesExplicit[0], 'http://127.0.0.1:42139');

// IPv6 回环会合点同样被接受
const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-discover6-'));
fs.writeFileSync(path.join(tmp6, 'l2d-service.json'), JSON.stringify({ origin: 'http://[::1]:42138' }));
const bases6 = candidateBases({ DSH_HOME: tmp6 });
assert.ok(bases6.includes('http://[::1]:42138'), `候选列表缺 IPv6 会合点: ${bases6.join(',')}`);

// 空目录 DSH_HOME：扫描无害，仍保留默认 5300 兜底
const tmpEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-discover-empty-'));
const basesEmpty = candidateBases({ DSH_HOME: tmpEmpty });
assert.ok(basesEmpty.includes('http://127.0.0.1:5300'));

console.log('discover ok');
