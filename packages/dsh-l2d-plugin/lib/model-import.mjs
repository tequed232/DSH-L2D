/**
 * model-import —— 设置页「模型 zip 导入」后端管线（传输无关，lib/index.js 与
 * tools/dev-server/index.mjs 双侧路由共用同一实例逻辑）。
 *
 * 职责（docs 与契约：POST /dsh-l2d/models/import 三端点）：
 *   - 任务注册表：同时只允许一个导入任务（409 busy 返回既有 jobId，前端可据此轮询）；
 *   - 步骤串行、步间检查取消：extracting → registering → scanning → 安装 → done；
 *   - 安装目标：宿主模型根目录 MODEL_DIR 顶层——既有加载链（getCurrentModelId =
 *     discoverModelFiles(MODEL_DIR)[0]，overlay 经 /dsh-l2d/status.json 解析当前模型）
 *     只发现顶层 .model3.json，导入的模型必须落进这个位置才能被现有链选中；
 *   - 能力三分类（supports/approximate/unsupported）与既有能力扫描产物同源：
 *     spawn tools/capability-scan/scan.mjs，读 profile.<modelId>.json 的 controls 映射；
 *   - exp3/motion3 引用写回（#28 方案 A）与 live2d-ids 清单：spawn 既有 CLI
 *     （tools/model-resources/register.mjs / tools/live2d-catalog/build-live2d-catalog.mjs），
 *     不复制粘贴逻辑；工具失败不阻塞导入（降级 warnings）。
 *
 * 复用方式说明：register / catalog / scan 三个工具是 CLI 形态（顶层直接执行，
 * 不可安全 import），统一走子进程 spawn——与既有 /dsh-l2d/capability/rescan 路由
 * spawn scan.mjs 同一模式，测试经 options.execTool 注入假实现。
 *
 * 取消语义：批间（步骤边界）粒度——正在执行的 spawn 步骤会跑完，下一步开始前感知。
 *
 * 注册表风格参考 nodegraph-runs.mjs：纯内存、时钟注入、绝不抛（管线内错误落
 * state:'error'），进程重启即清空。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { discoverModelFiles } from './host-guard.mjs';
import { readZipEntries, ZIP_ENTRY_DEFAULT_LIMITS } from './zip-reader.mjs';

/** 活跃状态：占用「同时只能一个导入任务」名额。 */
const ACTIVE_STATES = new Set(['queued', 'extracting', 'registering', 'scanning']);

export const MODEL_IMPORT_DEFAULTS = Object.freeze({
  maxZipBytes: 200 * 1024 * 1024,
  ...ZIP_ENTRY_DEFAULT_LIMITS,
  toolTimeouts: { register: 60_000, catalog: 180_000, scan: 300_000 },
});

/** 管线同步校验/步骤错误：路由与注册表统一消费 code/status/message。 */
export class ImportError extends Error {
  /**
   * @param {string} code not-zip | too-large | invalid-model | name-conflict | import-failed
   * @param {number} status HTTP 语义码（400/413/422/500）
   * @param {string} message 中文、面向用户可读
   * @param {object} [extra] 附加字段（如 invalid-model 的 reason）
   */
  constructor(code, status, message, extra = undefined) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.status = status;
    if (extra !== undefined) this.extra = extra;
  }
}

/** HTTP 请求体读取（zip 原始字节）。超限直接断开并抛 ImportError('too-large')。 */
export function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new ImportError('too-large', 413, '压缩包超过大小上限（' + Math.round(maxBytes / 1024 / 1024) + 'MB）'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new ImportError('import-failed', 500, '读取上传内容失败')));
  });
}

function currentModelIdOf(modelDir, fsImpl) {
  try {
    const first = discoverModelFiles(modelDir, fsImpl)[0];
    return first ? first.replace(/\.model3\.json$/, '') : '';
  } catch {
    return '';
  }
}

/** 递归找 .model3.json（相对 payload 根），条目数护栏防失控目录。 */
function findModel3Files(root, fsImpl) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 8 || found.length > 16) return;
    let items = [];
    try {
      items = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full, depth + 1);
      else if (item.isFile() && item.name.toLowerCase().endsWith('.model3.json')) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

/** 把 src 目录的一级内容搬进 dst（同名先删再搬，模型文件优先于 zip 根杂物）。 */
function moveContentsMerge(src, dst, fsImpl) {
  fsImpl.mkdirSync(dst, { recursive: true });
  for (const item of fsImpl.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, item.name);
    const to = path.join(dst, item.name);
    if (fsImpl.existsSync(to)) {
      fsImpl.rmSync(to, { recursive: true, force: true });
    }
    fsImpl.renameSync(from, to);
  }
}

/**
 * @param {{
 *   modelDir: string,
 *   repoRoot: string,
 *   fs?: typeof fs,
 *   now?: () => number,
 *   maxZipBytes?: number,
 *   maxEntries?: number,
 *   maxTotalUncompressedBytes?: number,
 *   toolTimeouts?: {register?: number, catalog?: number, scan?: number},
 *   scanOutDir?: string,
 *   execTool?: (job: {tool: 'register'|'catalog'|'scan', script: string, args: string[],
 *                      env: object, cwd: string, timeoutMs: number}) =>
 *                      Promise<{code: number, stdout: string, stderr: string, timedOut?: boolean}>,
 * }} options
 */
export function createModelImporter(options = {}) {
  const modelDir = options.modelDir;
  if (!modelDir || typeof modelDir !== 'string') {
    throw new Error('createModelImporter: modelDir 必填（宿主模型根目录）');
  }
  const repoRoot = options.repoRoot || process.cwd();
  const fsImpl = options.fs || fs;
  const now = options.now || Date.now;
  const maxZipBytes = Math.max(1, Math.floor(Number(options.maxZipBytes) || MODEL_IMPORT_DEFAULTS.maxZipBytes));
  const zipLimits = {
    maxEntries: options.maxEntries || MODEL_IMPORT_DEFAULTS.maxEntries,
    maxTotalUncompressedBytes: options.maxTotalUncompressedBytes || MODEL_IMPORT_DEFAULTS.maxTotalUncompressedBytes,
  };
  const timeouts = { ...MODEL_IMPORT_DEFAULTS.toolTimeouts, ...(options.toolTimeouts || {}) };
  const scanOutDir = options.scanOutDir || path.join(repoRoot, 'tools', 'capability-scan');

  /** jobId → record（纯内存，进程重启清空）。 */
  const records = new Map();

  function publicRecord(rec) {
    const out = {
      ok: true,
      jobId: rec.jobId,
      name: rec.name,
      state: rec.state,
      step: rec.step,
      progress: rec.progress,
      message: rec.message,
      cancelRequested: rec.cancelRequested,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
    if (rec.result !== null) out.result = rec.result;
    if (rec.error !== null) out.error = rec.error;
    return out;
  }

  function setStep(rec, state, step, progress, message) {
    rec.state = state;
    rec.step = step;
    rec.progress = progress;
    rec.message = message;
    rec.updatedAt = now();
  }

  /** 缺脚本 / 非零退出 / 超时都由调用方降级为 warning，这里只如实回报。 */
  function defaultExecTool(job) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let child;
      try {
        child = spawn(process.execPath, [job.script, ...job.args], {
          cwd: job.cwd,
          env: job.env,
          windowsHide: true,
        });
      } catch (err) {
        return resolve({ code: -1, stdout: '', stderr: String((err && err.message) || err) });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, job.timeoutMs);
      child.stdout.on('data', (c) => {
        stdout += String(c);
      });
      child.stderr.on('data', (c) => {
        stderr += String(c);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String((err && err.message) || err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code === null ? -1 : code, stdout, stderr, timedOut });
      });
    });
  }
  const execTool = options.execTool || defaultExecTool;
  const customExec = typeof options.execTool === 'function';

  /** spawn 既有 CLI 工具；返回 stderr 摘要或 null（成功）。失败一律 warning 不阻塞。
   *  注入 execTool（测试/部署替换执行器）时跳过脚本存在性检查——执行器自己负责。 */
  async function runCliTool(rec, job) {
    if (!customExec && !fsImpl.existsSync(job.script)) {
      rec.warnings.push(job.tool + '-skipped: 脚本不存在 ' + job.script);
      return null;
    }
    const out = await execTool(job);
    if (out.timedOut) {
      rec.warnings.push(job.tool + '-timeout: 超过 ' + Math.round(job.timeoutMs / 1000) + 's 被终止');
      return null;
    }
    if (out.code !== 0) {
      rec.warnings.push(job.tool + '-failed: ' + String(out.stderr || out.stdout || ('exit ' + out.code)).slice(-300));
      return null;
    }
    return out;
  }

  /** 能力三分类：与既有能力画像同源（profile.<modelId>.json 的 controls.status）。 */
  function capabilitiesFromProfile(profileFile) {
    let profile;
    try {
      profile = JSON.parse(fsImpl.readFileSync(profileFile, 'utf8'));
    } catch {
      return null;
    }
    const capabilities = { supports: [], approximate: [], unsupported: [] };
    for (const c of Array.isArray(profile.controls) ? profile.controls : []) {
      if (!c || typeof c.id !== 'string') continue;
      if (c.status === 'supported') capabilities.supports.push({ name: c.id });
      else if (c.status === 'approximate') capabilities.approximate.push({ name: c.id });
      else capabilities.unsupported.push({ name: c.id });
    }
    return capabilities;
  }

  function failJob(rec, err) {
    const code = err && err.code ? err.code : 'import-failed';
    let status = err && err.status ? err.status : 500;
    if (!err.status && err && err.name === 'ZipError') {
      // zip-reader 的错误落到管线内（无 HTTP 语境），这里统一映射契约状态码。
      status = { 'not-zip': 400, 'too-large': 413, 'zip-slip': 422, encrypted: 422, 'unsupported-method': 422, 'zip64-unsupported': 422, 'too-many-entries': 413 }[code] || 500;
    }
    setStep(rec, 'error', rec.step, rec.progress, '导入失败：' + (err && err.message ? err.message : String(err)));
    const extra = (err && err.extra) || {};
    rec.error = {
      code: status,
      reason: extra.reason || code,
      message: err && err.message ? err.message : String(err),
      ...(extra.files ? { files: extra.files } : {}),
    };
    rec.finishedAt = now();
  }

  /** 步骤边界取消检查：已请求取消 → 抛出由 runJob 落 cancelled 态。 */
  function checkCancel(rec) {
    if (rec.cancelRequested) {
      const err = new Error('已按请求取消导入');
      err.reason = 'cancelled';
      throw err;
    }
  }

  /**
   * 管线主体。所有终态路径收口：staging 清理、finishedAt、终态字段。
   * @param {object} rec 注册表记录（内部直引用）
   * @param {{data: Buffer, stagingDir: string, payloadDir: string, preModelId: string}} ctx
   */
  async function runJob(rec, ctx) {
    const { data, stagingDir, payloadDir, preModelId } = ctx;
    const warnings = rec.warnings;
    try {
      // ---- extracting：解压（安全校验在 zip-reader，zip-slip / 炸弹在那里拦）----
      setStep(rec, 'extracting', 'unzip', 10, '正在校验并解压压缩包…');
      const entries = readZipEntries(data, zipLimits);
      if (!entries.length) {
        throw new ImportError('invalid-model', 422, '压缩包里没有文件', { reason: 'no-model3' });
      }
      fsImpl.mkdirSync(payloadDir, { recursive: true });
      for (const entry of entries) {
        const target = path.join(payloadDir, entry.name);
        if (!target.startsWith(payloadDir + path.sep) && target !== payloadDir) {
          // zip-reader 已做名字校验，这里兜底（纵深防御）。
          throw new ImportError('invalid-model', 422, '压缩包含路径穿越条目：' + entry.name, { reason: 'zip-slip' });
        }
        fsImpl.mkdirSync(path.dirname(target), { recursive: true });
        fsImpl.writeFileSync(target, entry.data);
      }

      // ---- locating model3（仍在 extracting 状态内）----
      setStep(rec, 'extracting', 'locate-model3', 30, '正在定位 model3.json…');
      const model3List = findModel3Files(payloadDir, fsImpl);
      if (model3List.length === 0) {
        throw new ImportError('invalid-model', 422, '压缩包里没有找到 .model3.json：请确认压缩的是完整模型目录', { reason: 'no-model3' });
      }
      if (model3List.length > 1) {
        throw new ImportError('invalid-model', 422, '压缩包里有 ' + model3List.length + ' 个 .model3.json，只能包含一个模型', {
          reason: 'multi-model3',
          files: model3List.map((p) => path.relative(payloadDir, p)).slice(0, 8),
        });
      }
      let model3Path = model3List[0];
      let raw;
      try {
        raw = fsImpl.readFileSync(model3Path, 'utf8');
        JSON.parse(raw);
      } catch {
        throw new ImportError('invalid-model', 422, 'model3.json 不是合法 JSON：' + path.basename(model3Path), { reason: 'bad-json' });
      }
      // 嵌套目录（zip 单根文件夹）抬升：model3.json 必须落到 payload 根，
      // 否则安装后不被 discoverModelFiles 发现（既有加载链只看顶层）。
      const model3Dir = path.dirname(model3Path);
      if (model3Dir !== payloadDir) {
        moveContentsMerge(model3Dir, payloadDir, fsImpl);
        model3Path = path.join(payloadDir, path.basename(model3Path));
        // 抬升后清理留空的中间目录，避免安装时空目录混进模型根。
        let emptyDir = model3Dir;
        while (emptyDir !== payloadDir) {
          try {
            const left = fsImpl.readdirSync(emptyDir);
            if (left.length) break;
            fsImpl.rmdirSync(emptyDir);
            emptyDir = path.dirname(emptyDir);
          } catch {
            break;
          }
        }
      }
      const modelId = path.basename(model3Path).replace(/\.model3\.json$/, '');

      // ---- 安装冲突预检（fail fast，不浪费后面的步骤）----
      // 同名 model3.json 已存在 → 视为同模型重导入/升级，允许覆盖；
      // 否则任何内容不同的同名文件都是冲突（绝不覆盖别的模型的文件）。
      const reimport = fsImpl.existsSync(path.join(modelDir, path.basename(model3Path)));
      const conflicts = [];
      for (const item of fsImpl.readdirSync(payloadDir, { withFileTypes: true })) {
        const target = path.join(modelDir, item.name);
        if (!fsImpl.existsSync(target)) continue;
        if (reimport) continue;
        if (item.isDirectory() !== fsImpl.statSync(target).isDirectory()) {
          conflicts.push(item.name);
          continue;
        }
        if (!item.isDirectory()) {
          const a = fsImpl.readFileSync(target);
          const b = fsImpl.readFileSync(path.join(payloadDir, item.name));
          if (!a.equals(b)) conflicts.push(item.name);
        } else {
          conflicts.push(item.name + '/');
        }
      }
      if (conflicts.length) {
        throw new ImportError('name-conflict', 500, '模型根目录已存在同名但内容不同的文件，拒绝覆盖（' + conflicts.slice(0, 5).join(', ') + '）。请重命名模型后重试。');
      }

      // ---- registering：#28 方案 A 引用写回 + live2d-ids 清单（spawn 既有 CLI）----
      checkCancel(rec);
      setStep(rec, 'registering', 'register-resources', 45, '正在登记模型资源（exp3/motion3 引用写回）…');
      await runCliTool(rec, {
        tool: 'register',
        script: path.join(repoRoot, 'tools', 'model-resources', 'register.mjs'),
        args: ['--model-dir', payloadDir],
        env: { ...process.env },
        cwd: repoRoot,
        timeoutMs: timeouts.register,
      });
      checkCancel(rec);
      setStep(rec, 'registering', 'build-catalog', 55, '正在生成 Live2D 目录与 live2d-ids 清单…');
      await runCliTool(rec, {
        tool: 'catalog',
        script: path.join(repoRoot, 'tools', 'live2d-catalog', 'build-live2d-catalog.mjs'),
        args: [],
        env: { ...process.env, DSH_L2D_MODEL_DIR: payloadDir },
        cwd: repoRoot,
        timeoutMs: timeouts.catalog,
      });

      // ---- scanning：能力画像（失败降级 capabilities:null + warnings）----
      checkCancel(rec);
      setStep(rec, 'scanning', 'scan-capability', 70, '正在扫描模型能力（语义通道三分类）…');
      await runCliTool(rec, {
        tool: 'scan',
        script: path.join(repoRoot, 'tools', 'capability-scan', 'scan.mjs'),
        args: ['--model-dir', payloadDir, '--out-dir', scanOutDir],
        env: { ...process.env },
        cwd: repoRoot,
        timeoutMs: timeouts.scan,
      });
      const capabilities = capabilitiesFromProfile(path.join(scanOutDir, 'profile.' + modelId + '.json'));
      if (!capabilities) {
        warnings.push('scan-missing: 能力画像不可用（扫描失败或未产出），capabilities 置空');
      }

      // ---- 安装：payload 顶层内容 → MODEL_DIR 顶层 ----
      checkCancel(rec);
      setStep(rec, 'scanning', 'install', 90, '正在安装模型文件到模型目录…');
      moveContentsMerge(payloadDir, modelDir, fsImpl);
      const postModelId = currentModelIdOf(modelDir, fsImpl);
      const switched = Boolean(postModelId) && postModelId !== preModelId;

      const result = {
        modelId,
        name: modelId,
        capabilities,
        warnings,
        switched,
      };
      rec.result = result;
      setStep(rec, 'done', 'done', 100, '导入完成' + (switched ? '，当前模型已切换为 ' + modelId : '。刷新页面后新模型生效'));
      rec.finishedAt = now();
    } catch (err) {
      if (err && err.reason === 'cancelled') {
        setStep(rec, 'cancelled', rec.step, rec.progress, '导入已取消（在「' + (rec.step || 'queued') + '」步骤边界生效）');
        rec.finishedAt = now();
        return;
      }
      failJob(rec, err);
    } finally {
      try {
        fsImpl.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响终态 */
      }
    }
  }

  return {
    /** 供路由断言/测试内省。 */
    maxZipBytes,
    zipLimits,

    /**
     * 同步校验 + 建档 + 异步起管线。
     * @param {{filename?: string, data: Buffer}} input
     * @returns {{ok: true, jobId: string} |
     *           {ok: false, status: 409, reason: 'busy', existingJobId: string, message: string}}
     * @throws ImportError not-zip(400) / too-large(413)
     */
    beginImport(input) {
      const filename = typeof (input && input.filename) === 'string' ? input.filename : '';
      const data = input && input.data;
      if (!Buffer.isBuffer(data) || data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
        throw new ImportError('not-zip', 400, '上传内容不是 zip 文件（缺少 PK 魔数）');
      }
      if (data.length > maxZipBytes) {
        throw new ImportError('too-large', 413, '压缩包超过大小上限（' + Math.round(maxZipBytes / 1024 / 1024) + 'MB）');
      }
      if (filename && !filename.toLowerCase().endsWith('.zip')) {
        throw new ImportError('not-zip', 400, '只支持 .zip 压缩包：' + filename);
      }
      for (const rec of records.values()) {
        if (ACTIVE_STATES.has(rec.state)) {
          return {
            ok: false,
            status: 409,
            reason: 'busy',
            existingJobId: rec.jobId,
            message: '已有导入任务在进行中（jobId: ' + rec.jobId + '），请先等待其完成或取消',
          };
        }
      }
      const jobId = randomUUID();
      const preModelId = currentModelIdOf(modelDir, fsImpl);
      const rec = {
        jobId,
        name: filename || 'model.zip',
        state: 'queued',
        step: 'queued',
        progress: 0,
        message: '已受理，等待解压',
        result: null,
        error: null,
        warnings: [],
        cancelRequested: false,
        createdAt: now(),
        updatedAt: now(),
        finishedAt: null,
      };
      records.set(jobId, rec);
      // 暂存目录放模型根目录的兄弟位置（同卷 rename 快；不可写则退回系统临时目录）。
      let stagingRoot;
      const siblingRoot = path.join(path.dirname(modelDir), '.l2d-model-import');
      try {
        fsImpl.mkdirSync(siblingRoot, { recursive: true });
        stagingRoot = siblingRoot;
      } catch {
        stagingRoot = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'l2d-import-'));
      }
      const stagingDir = path.join(stagingRoot, jobId);
      const payloadDir = path.join(stagingDir, 'payload');
      runJob(rec, { data, stagingDir, payloadDir, preModelId }).catch((err) => {
        // runJob 自己兜全部终态；这里只防管线骨架本身的意外。
        if (rec.state === 'queued' || ACTIVE_STATES.has(rec.state)) failJob(rec, err);
      });
      return { ok: true, jobId };
    },

    /** GET 单任务。不存在返回 null（路由映射 404）。 */
    get(jobId) {
      const rec = records.get(jobId);
      return rec ? publicRecord(rec) : null;
    },

    /** 取消：步骤边界生效；终态/缺失任务不可取消。 */
    cancel(jobId) {
      const rec = records.get(jobId);
      if (!rec) return { ok: false, error: 'not-found' };
      if (!ACTIVE_STATES.has(rec.state)) {
        return { ok: false, error: 'not-cancellable', state: rec.state };
      }
      rec.cancelRequested = true;
      rec.updatedAt = now();
      return { ok: true, cancelled: true };
    },

    /** 测试与诊断用：内部记录直引用（含 warnings）。 */
    _recordRaw(jobId) {
      return records.get(jobId) || null;
    },
  };
}
