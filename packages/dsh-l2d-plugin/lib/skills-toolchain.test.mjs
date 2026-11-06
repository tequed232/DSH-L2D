import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SKILLS_CHECK_LOG_FILE_NAME,
  appendSkillsCheckLog,
  checkSkillDir,
  maybeRunStartupSkillsCheck,
  parseSkillFrontmatter,
  runSkillsToolchainCheck,
  skillsCheckLogPath,
} from './skills-toolchain.mjs';

const VALID_SKILL_MD = [
  '---',
  'name: dsh-l2d-team',
  'description: 多智能体攻坚组编排章程与启动协议。',
  'agent_created: true',
  '---',
  '',
  '# DSH-L2D Team',
  '',
  '模板见 `references/charter-template.md`。',
  '',
].join('\n');

function mkSkill(root, name, md, files = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (md !== null) fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

// 1. frontmatter 解析：正常 / 缺失 / 未闭合。
const fm = parseSkillFrontmatter(VALID_SKILL_MD);
assert.equal(fm.ok, true);
assert.equal(fm.data.name, 'dsh-l2d-team');
assert.equal(fm.data.agent_created, 'true');
assert.equal(parseSkillFrontmatter('no frontmatter').ok, false);
assert.equal(parseSkillFrontmatter('---\nname: x').ok, false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skills-'));
const repoRoot = path.join(tmp, 'repo-skills');
const scratchRoot = path.join(tmp, 'scratch-skills'); // 直接 checkSkillDir 用的破坏性样本，不进全量扫描

// 2. 单目录检查：合法 skill 无异常；引用缺失 / 零字节 / 名称不一致 / 空 description 被点名。
const good = mkSkill(repoRoot, 'dsh-l2d-team', VALID_SKILL_MD, {
  'references/charter-template.md': '# Charter\n',
});
const goodCheck = checkSkillDir(good);
assert.equal(goodCheck.ok, true);
assert.deepEqual(goodCheck.anomalies, []);

const badDir = mkSkill(scratchRoot, 'dsh-l2d-team', VALID_SKILL_MD.replace('charter-template.md', 'gone.md'), {
  'references/gone.md.placeholder': '', // 零字节
});
const badCheck = checkSkillDir(badDir);
assert.equal(badCheck.ok, false);
assert.ok(badCheck.anomalies.some((a) => a.code === 'missing-file' && a.detail === 'references/gone.md'));
assert.ok(badCheck.anomalies.some((a) => a.code === 'empty-file'));

const mismatch = checkSkillDir(mkSkill(scratchRoot, 'renamed-skill', VALID_SKILL_MD));
assert.ok(mismatch.anomalies.some((a) => a.code === 'name-mismatch'));

const noDesc = checkSkillDir(mkSkill(scratchRoot, 'no-desc', VALID_SKILL_MD.replace('description: 多智能体攻坚组编排章程与启动协议。', 'description:')));
assert.ok(noDesc.anomalies.some((a) => a.code === 'missing-description'));

fs.mkdirSync(path.join(scratchRoot, 'hollow'), { recursive: true }); // 无 SKILL.md
assert.ok(checkSkillDir(path.join(scratchRoot, 'hollow')).anomalies.some((a) => a.code === 'missing-skill-md'));

// 3. 全量自检（干净仓库根）：ok、安装一致 → 无 not-installed/drift。
const userRoot = path.join(tmp, 'user-skills');
fs.mkdirSync(userRoot, { recursive: true });
fs.cpSync(good, path.join(userRoot, 'dsh-l2d-team'), { recursive: true });

const baseOpts = {
  repoSkillsDir: repoRoot,
  homeSkillsDir: path.join(tmp, 'home-skills'),
  userSkillsDir: userRoot,
  homeDir: path.join(tmp, 'home'),
};
const healthy = runSkillsToolchainCheck(baseOpts);
assert.equal(healthy.ok, true);
assert.equal(healthy.roots.userRootAvailable, true);
assert.ok(healthy.skills.some((s) => s.name === 'dsh-l2d-team' && s.source === 'repo'));
assert.equal(healthy.anomalies.length, 0);

// 3b. 放入坏 skill 后：各自被点名 + 未安装点名。
mkSkill(repoRoot, 'renamed-skill', VALID_SKILL_MD);
mkSkill(repoRoot, 'no-desc', VALID_SKILL_MD.replace('description: 多智能体攻坚组编排章程与启动协议。', 'description:'));
fs.mkdirSync(path.join(repoRoot, 'hollow'), { recursive: true });
const withBroken = runSkillsToolchainCheck(baseOpts);
assert.equal(withBroken.ok, false);
for (const code of ['missing-skill-md', 'name-mismatch', 'missing-description']) {
  assert.ok(withBroken.anomalies.some((a) => a.code === code), 'expected anomaly ' + code);
}
assert.ok(withBroken.anomalies.some((a) => a.code === 'not-installed' && a.skill === 'renamed-skill'));

// 4. 漂移：改动已安装副本内容。
fs.writeFileSync(path.join(userRoot, 'dsh-l2d-team', 'SKILL.md'), VALID_SKILL_MD + 'extra line\n');
const drifted = runSkillsToolchainCheck(baseOpts);
assert.ok(drifted.anomalies.some((a) => a.code === 'drift' && a.skill === 'dsh-l2d-team'));

// 5. log：有异常才追加；全部正常不写。
const logFile = skillsCheckLogPath(baseOpts.homeDir);
assert.equal(logFile.endsWith(SKILLS_CHECK_LOG_FILE_NAME), true);
assert.equal(fs.existsSync(logFile), false);
const logged1 = appendSkillsCheckLog(drifted, baseOpts);
assert.equal(logged1.logged, true);
assert.ok(fs.readFileSync(logFile, 'utf8').includes('"code":"drift"'));
appendSkillsCheckLog(healthy, baseOpts);
const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
assert.equal(lines.length, 1);

// 超限截断：maxBytes 调小后追加会丢掉旧行。
for (let i = 0; i < 5; i++) {
  appendSkillsCheckLog(drifted, { ...baseOpts, maxBytes: 40 });
}
const truncated = fs.readFileSync(logFile, 'utf8').trim().split('\n');
assert.ok(truncated.length < 6, 'log 应被截断保留较新一半');

// 6. 仓库根与部署根都缺失 → skills-dir-missing；用户级根缺失不算异常。
const orphan = runSkillsToolchainCheck({
  repoSkillsDir: path.join(tmp, 'nope-repo'),
  homeSkillsDir: path.join(tmp, 'nope-home'),
  userSkillsDir: path.join(tmp, 'nope-user'),
  homeDir: path.join(tmp, 'home2'),
});
assert.ok(orphan.anomalies.some((a) => a.code === 'skills-dir-missing'));
assert.equal(orphan.roots.userRootAvailable, false);
assert.equal(orphan.anomalies.some((a) => a.code === 'not-installed'), false);

// 7. maybeRunStartupSkillsCheck：force 跑通且 fail-open。
assert.ok(maybeRunStartupSkillsCheck({ ...baseOpts, force: true }));
assert.ok(maybeRunStartupSkillsCheck({ repoSkillsDir: path.join(tmp, 'nope-repo'), homeSkillsDir: path.join(tmp, 'nope-home'), force: true }));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('skills-toolchain ok');
