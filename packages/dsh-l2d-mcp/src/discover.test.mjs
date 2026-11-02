import assert from 'node:assert/strict';
import { extractPorts, isLoopbackUrl, candidateBases } from './discover.mjs';

assert.deepEqual(extractPorts('listen 5300\n"port": 4310\nhttp://127.0.0.1:8787/x'), [5300, 4310, 8787]);
assert.equal(isLoopbackUrl('http://127.0.0.1:5300'), true);
assert.equal(isLoopbackUrl('http://example.com:5300'), false);
const bases = candidateBases({ DSH_L2D_URL: 'http://8.8.8.8:9' });
assert.equal(bases.includes('http://8.8.8.8:9'), false);
assert.equal(bases.includes('http://127.0.0.1:5300'), true);
console.log('discover ok');
