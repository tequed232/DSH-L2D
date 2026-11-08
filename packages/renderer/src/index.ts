/**
 * DSH-L2D 渲染包（官方 Cubism Web SDK 版）
 *
 * 不再依赖第三方 pixi 封装：直接使用 SDK 自带的 Framework + 样例的 LApp* 装配，
 * 由我们控制初始化、加载、每帧绘制与缩放，保证「整个模型完整显示」。
 *
 * 对外暴露 window.DSH_L2D（IIFE），插件前端按需调用。
 */
import { CubismFramework, Option, LogLevel } from './fw/live2dcubismframework';
import { CubismShaderManager_WebGL } from './fw/rendering/cubismshader_webgl';
import { LAppSubdelegate } from './app/lappsubdelegate';
import { LAppPal } from './app/lapppal';
import type { LAppModel } from './app/lappmodel';
import { ParamInjector, parameterIndexOf } from './app/param-injector';
import { isHostable } from './app/param-host-policy';
import { EmotionRouter, EmotionIntent, EmotionSignal } from './app/emotion-router';
import { MotionDirector, motionsShareArm } from './app/motion-director';
import { PoseController, POSE_IDS } from './app/pose-controller';
import { FacialBridge, type FacialFrame, type FacialSemantic } from './app/facial-bridge.ts';
import { SHADER_SOURCES } from './shaders';
import { mixAdditive } from '../../core/src/angle-mix.ts';
import { sampleAmbient, type AmbientKind } from '../../core/src/ambient.ts';
import { LIPSYNC_PARAMS } from '../../core/src/index.ts';
import { normalizeActChain } from '../../core/src/chain-normalize.ts';
import { admitKeyframeTrack } from './app/keyframe-admission.ts';
import { createCompletionBus, type ActionCompletionEvent } from './app/action-completion.ts';
import {
  createGestureBridge,
  type GestureAdmitOptions,
  type GestureBridgeSnapshot,
  type GestureSegmentInput,
} from './app/gesture-bridge';
import { createCueBridge, type CueBridgeSnapshot, type CueStopOutcome } from './app/cue-bridge';
// P0 修复（模型加载失败）：DEFAULT_EMBODIED_FLAGS 在 514/531 行被使用，但此前漏了
// 这条 import——bundle 里成了裸全局引用，IIFE 顶层执行即抛 ReferenceError，
// window.DSH_L2D 永不挂载，模型加载必失败（截图报错 DEFAULT_EMBODIED_FLAGS is not defined）。
// motion-adapter 不反向 import index，无循环依赖。
import { DEFAULT_EMBODIED_FLAGS, createPhysicsGate } from './app/motion-adapter';
import type { EmbodiedCue } from '../../core/src/embodied-cue.ts';
import type { CueReleaseSelector } from '../../core/src/cue-loop.ts';
import type { StopSelector } from '../../core/src/gesture-timeline.ts';
import {
  ActGate,
  closeMotionsOnPreempt,
  countRealCompletions,
  getActPhaseTemplate,
  motionResultKind,
  preemptedYandere,
  type ActAdmitInput,
  type ActPhaseTemplate,
} from '../../core/src/action-chain.ts';

let sub: LAppSubdelegate | null = null;
let model: LAppModel | null = null;
/** 当前尝试加载的模型文件名（model3.json basename），供 overlay 日志等自省展示；未加载为 ''。 */
let modelLabel = '';
// 具名导出（live binding）：overlay 日志以 `L.modelName || L.model` 读模型名；
// renderer-contract 要求 overlay 依赖的每个成员都必须具名导出，而非只挂在 default api 上。
export { modelLabel as modelName, modelLabel as model };
let rafId = 0;
let started = false;
let lastError = '';
let frames = 0;
let canvasEl: HTMLCanvasElement | null = null;

/** model3.json 原文，用于自省表情/动作组（不依赖 SDK 内部结构） */
interface ModelSettingRefs {
  Moc?: string;
  Expressions?: Array<{ Name?: string; File?: string }>;
  Motions?: Record<string, Array<{ File?: string }>>;
  Physics?: string;
  Parameters?: Array<{ Id?: string; Min?: number; Max?: number; Default?: number }>;
}
interface ModelSetting {
  FileReferences?: ModelSettingRefs;
}
let modelSetting: ModelSetting | null = null;
let currentZoom = 1;
const injector = new ParamInjector();
const motionDirector = new MotionDirector();
const poseController = new PoseController();

// [M1-b] PhysicsGate 接线（根修：此前 index.ts 只有 destroy 处孤调用
// physicsGate.dispose()，实例从未创建——destroy 必抛 ReferenceError，
// 清理中断、实例残留，下一次挂载被污染；即「模型导入失败」根因之一）。
// 接线位置遵循 motion-adapter.ts「两个调用位置」契约：pre 钩子尾、post 钩子
// injector.apply('post') 前。flag 关（默认）时 pre/post/dispose 全部空实现，
// 帧循环行为与未接线时逐字节一致。limb 通道未接（M1-G 规划中，README 路线图）。
const physicsGate = createPhysicsGate(DEFAULT_EMBODIED_FLAGS, {
  preOwnedIds: () => injector.getPreOwnedIds(),
});

/** 页面里加载 Cubism Core（幂等） */
export function loadCore(url: string): Promise<void> {
  const w = window as unknown as { Live2DCubismCore?: unknown };
  if (w.Live2DCubismCore) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('core load failed: ' + url));
    document.head.appendChild(s);
  });
}

export interface MountOptions {
  modelUrl: string;
  width?: number;
  height?: number;
  zoom?: number;
  /** 渲染倍率（CSS → 设备像素）：高 DPI/Retina 用 devicePixelRatio，普通屏可传 2 做超采样。0 = 交给浏览器。 */
  dpr?: number;
}

/** 渲染倍率护栏：1~8 倍；8K 像素上限在 subdelegate.resizeCanvas 内统一钳制。 */
function clampRenderScale(value: number | undefined): number {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(8, Math.max(1, v));
}

function splitUrl(url: string): { dir: string; file: string } {
  const clean = url.split('?')[0];
  const i = clean.lastIndexOf('/');
  return { dir: clean.slice(0, i + 1), file: clean.slice(i + 1) };
}

function bootFramework(): void {
  if (started) return;
  const option = new Option();
  option.logFunction = (m: string) => console.log('[cubism]', m);
  option.loggingLevel = LogLevel.LogLevel_Warning;
  CubismFramework.startUp(option);
  CubismFramework.initialize();
  started = true;
}

/**
 * 把内联的 shader 源码注入 CubismShader_WebGL，并短路掉它的网络加载。
 *
 * Cubism 5-r.5 默认会 fetch `../../Framework/Shaders/WebGL/*.vert|.frag`。
 * 打包后这个相对路径一定取不到，而失败路径是静默的（catch 里只 console.error，
 * 源码被填成空串），最终表现为「模型加载成功、帧循环在跑、但每帧刷
 * Shader program is not initialized，画面全透明」。
 *
 * 必须在 sub.initialize() 之后调用 —— 要先有 gl 上下文，才能拿到对应的 shader 实例。
 */
let shaderDiag = 'not-run';
let fitDiag = 'not-run';
/** fitModel 的数值快照，供同步包围盒命中（右键菜单）使用 */
let fitState: { x0: number; y0: number; w: number; h: number; sx: number; sy: number; tx: number; ty: number } | null = null;

function installEmbeddedShaders(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  try {
    const mgr = CubismShaderManager_WebGL.getInstance();
    // getShader(gl) 只做 map 查询、不会新建实例；必须先 setGlContext 注册，
    // 否则拿到 undefined，注入会静默失效。
    mgr.setGlContext(gl as WebGLRenderingContext);
    const shader = mgr.getShader(gl as WebGLRenderingContext) as unknown as Record<string, unknown>;
    if (!shader) throw new Error('getShader 返回空');

    Object.assign(shader, SHADER_SOURCES);
    // 私有方法：让 generateShaders 里的 `this.loadShaders().then(...)` 立刻 resolve
    shader.loadShaders = () => Promise.resolve();
    // 复位状态，使下一次 doDrawModel 用已注入的源码重新 registerShader
    shader._isShaderLoading = false;
    shader._isShaderLoaded = false;
    shader._shaderSets = [];

    // 诊断：手动编译一遍主顶点着色器，抓真实 info log
    // （SDK 自己的日志格式串是 '{0}' 占位但没做替换，细节会被吞掉）
    const vs = gl.createShader(gl.VERTEX_SHADER);
    if (!vs) {
      shaderDiag = 'createShader 失败';
    } else {
      gl.shaderSource(vs, SHADER_SOURCES._vertShaderSrc);
      gl.compileShader(vs);
      const ok = gl.getShaderParameter(vs, gl.COMPILE_STATUS);
      const log = gl.getShaderInfoLog(vs);
      shaderDiag = ok
        ? 'vs-ok len=' + SHADER_SOURCES._vertShaderSrc.length
        : 'vs-fail [' + String(log) + '] len=' + SHADER_SOURCES._vertShaderSrc.length;
      gl.deleteShader(vs);
    }
  } catch (err) {
    shaderDiag = 'inject-fail: ' + String(err && (err as Error).message ? (err as Error).message : err);
    lastError = shaderDiag;
  }
}

/**
 * 让整个模型（含完整身体）居中落在画布内。
 *
 * 三个必须注意的点：
 *  1. 本模型的 model3.json 没有 Layout 字段，setupFromLayout 不会执行，
 *     所以 CubismModelMatrix 默认的 setHeight(2.0) 会把模型摆在视图左下象限，
 *     必须自己居中。
 *  2. setWidth/setHeight 是「相对累乘」（内部用构造时缓存的 _width/_height 求比例），
 *     反复调用会越缩越小，因此这里先 loadIdentity() 再写参数。
 *  3. 可视范围与 onUpdate 里的投影校正必须成对，否则两边各算一次比例。
 *     约定：视图短边恒为 2 个单位（即 x/y ∈ [-1,1] 的方形单位）。
 */
/** 在模型坐标系下统计实际可见顶点的包围盒 */
function computeBounds(core: {
  getDrawableCount?: () => number;
  getDrawableVertexCount?: (i: number) => number;
  getDrawableVertexPositions?: (i: number) => Float32Array;
  getDrawableOpacity?: (i: number) => number;
}): { x0: number; y0: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const n = core.getDrawableCount ? core.getDrawableCount() : 0;
  for (let i = 0; i < n; i++) {
    try {
      // 跳过完全透明的部件（未显示的尾巴/道具会把包围盒撑大）
      if (core.getDrawableOpacity && core.getDrawableOpacity(i) <= 0.01) continue;
      const vc = core.getDrawableVertexCount ? core.getDrawableVertexCount(i) : 0;
      if (!vc) continue;
      const pos = core.getDrawableVertexPositions ? core.getDrawableVertexPositions(i) : null;
      if (!pos) continue;
      for (let j = 0; j < vc; j++) {
        const x = pos[j * 2];
        const y = pos[j * 2 + 1];
        if (!isFinite(x) || !isFinite(y)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    } catch {
      /* 单个 drawable 异常不影响整体 */
    }
  }

  if (!isFinite(minX) || maxX <= minX || maxY <= minY) return null;
  return { x0: minX, y0: minY, w: maxX - minX, h: maxY - minY };
}

let lastFit = { w: 0, h: 0 };
let refitLeft = 0;
let lastParamSample: number | null = null;

/**
 * 让整个模型（含完整身体）居中铺满画布。
 *
 * 用「可见顶点包围盒」而不是 canvasWidth/Height：后者记录的是整张画布尺寸，
 * 角色在画布里往往偏置（留白不对称），直接按画布适配会表现为人物偏到一角、
 * 而且看着明显偏小。
 *
 * 投影矩阵是单位阵（见 LAppLive2DManager.onUpdate），所以这里直接按像素换算，
 * 不依赖 multiplyByMatrix 的乘法方向，也不会和 demo 的 _viewMatrix 重复缩放。
 */
function fitModel(width: number, height: number, zoom: number): void {
  if (!model) return;
  const core = model.getModel();
  if (!core) return;

  lastFit = { w: width, h: height };

  const canvasW = core.getCanvasWidth();
  const canvasH = core.getCanvasHeight();
  if (!canvasW || !canvasH) return;

  let box = computeBounds(core as never);
  // 包围盒异常（顶点为空、比例离谱）时回退到画布范围，避免把模型缩没
  if (box) {
    const ratio = box.w / box.h;
    if (!isFinite(ratio) || ratio <= 0.02 || ratio >= 50) box = null;
  }
  const x0 = box ? box.x0 : 0;
  const y0 = box ? box.y0 : 0;
  const boxW = box ? box.w : canvasW;
  const boxH = box ? box.h : canvasH;

  // 等比：取更受限的一边，整个角色必然落在画布内
  const pxPerUnit = Math.min(width / boxW, height / boxH) * zoom;
  const sx = (2 * pxPerUnit) / width;
  const sy = (2 * pxPerUnit) / height;

  const matrix = model.getModelMatrix();
  // setWidth/setHeight 是相对累乘，重复调用会越缩越小，所以每次先复位
  matrix.loadIdentity();
  matrix.scale(sx, sy);
  // 顶点变换 x' = sx * x + tx；要让包围盒中心落在原点，即 tx = -sx * (x0 + w/2)
  matrix.translate(-(x0 + boxW / 2) * sx, -(y0 + boxH / 2) * sy);
  fitState = {
    x0,
    y0,
    w: boxW,
    h: boxH,
    sx,
    sy,
    tx: -(x0 + boxW / 2) * sx,
    ty: -(y0 + boxH / 2) * sy,
  };

  const a = matrix.getArray();
  fitDiag =
    'box=[' + x0.toFixed(3) + ',' + y0.toFixed(3) + ',' + boxW.toFixed(3) + ',' + boxH.toFixed(3) + ']' +
    ' k=' + pxPerUnit.toFixed(1) +
    ' m=[' + a[0].toFixed(3) + ',' + a[5].toFixed(3) + ',' + a[12].toFixed(3) + ',' + a[13].toFixed(3) + ']';
}

export async function mount(canvas: HTMLCanvasElement, opts: MountOptions): Promise<void> {
  await destroy();

  const width = Math.max(1, Math.round(opts.width ?? canvas.clientWidth ?? 300));
  const height = Math.max(1, Math.round(opts.height ?? canvas.clientHeight ?? 400));
  currentZoom = opts.zoom ?? 1;
  canvasEl = canvas;

  bootFramework();

  // 先设定 CSS 尺寸：subdelegate 初始化时会按 clientWidth/Height 决定画布分辨率
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = width;
  canvas.height = height;

  sub = new LAppSubdelegate();
  // 高 DPI 适配：画布分辨率 = CSS 尺寸 × 倍率（上层传 devicePixelRatio 或超采样倍数）
  sub.renderScale = clampRenderScale(opts.dpr);
  if (!sub.initialize(canvas)) throw new Error('WebGL 初始化失败');

  // 必须在拿到 gl 之后、第一次 draw 之前注入 shader
  const gl = sub.getGl();
  if (gl) installEmbeddedShaders(gl);

  canvas.width = width;
  canvas.height = height;
  sub.onResize();
  // onResize 会按 clientWidth × 倍率重算分辨率；极端情况下拿不到布局尺寸时保底
  if (!canvas.width || !canvas.height) {
    canvas.width = width;
    canvas.height = height;
  }

  const { dir, file } = splitUrl(opts.modelUrl);
  const mgr = sub.getLive2DManager();
  // [H2] 错误监听先于 loadModelUrl：moc 同步失败链可能在 loadModelUrl 返回前
  // 就派发 dsh:l2d:model-error（旧实现监听器在 waitForModel 内才挂载，早期错误
  // 丢失 → 永远卡 15s 超时）。earlyError 由 waitForModel 轮询消费，mount 重试时重置。
  const earlyErrorRef: { message: string | null } = { message: null };
  const onEarlyModelError = (ev: Event) => {
    const detail = (ev as CustomEvent).detail as { message?: string } | undefined;
    earlyErrorRef.message = detail?.message || '模型资源加载失败';
  };
  window.addEventListener('dsh:l2d:model-error', onEarlyModelError);
  model = mgr.loadModelUrl(dir, file);
  // 模型名与 model 变量同生命周期：开始加载即记录（旧实例已在 mount 开头 destroy）。
  modelLabel = String(file || '');

  // 拉一份 model3.json：表情名与动作组清单从这里来，供 getCapabilities() 自省
  modelSetting = null;
  try {
    const res = await fetch(opts.modelUrl, { cache: 'no-store' });
    if (res.ok) modelSetting = (await res.json()) as ModelSetting;
  } catch {
    /* 拿不到就不提供自省，不影响渲染 */
  }

  try {
    await waitForModel(15000, earlyErrorRef);
  } finally {
    window.removeEventListener('dsh:l2d:model-error', onEarlyModelError);
  }
  // 首次动作调用必须等预加载完成，否则一定命中「缓存尚未写入」的竞态。
  await model.waitForAllMotions(12000);

  // FI：真实参数扫描 → 语义映射。每次模型加载执行一次；模型切换重建绑定（任务书 Part 10）。
  // 不存在的语义（如眉毛）不生成映射、永不写入、进 unsupported 诊断，不伪造写入成功。
  facialBridge.configure(
    (modelSetting?.FileReferences?.Parameters || [])
      .map((p) => ({
        id: String(p?.Id ?? ''),
        min: Number(p?.Min ?? 0),
        max: Number(p?.Max ?? 0),
        defaultValue: Number(p?.Default ?? 0),
      }))
      .filter((p) => p.id),
  );

  // 唯一正确的外部写入窗口：saveParameters 之后、物理/表情更新之前。
  // 兼容旧 setPreUpdate 名称，但实际已不在 sub.update() 之前执行。
  // 两个注入相位：
  //   pre  = 物理输入（Angle/Position），必须在物理更新前
  //   post = 姿势/关键帧 set 值，必须在 PoseUpdater 后，否则被覆盖
  model.setPreLateUpdateHook((core) => {
    phaseDiag.pre++;
    if (preUpdateHook) preUpdateHook();
    // 先算注视（头部直写 + 身体量写 angleBus.gaze），再和拖拽/微动作/媒体律动一起
    // 走 mixAdditive 限幅并只注入一次——否则 gaze 的 set 写入会把拖拽 PositionX 顶掉。
    applyGazeBody(core);
    flushAngleBus(core);
    // FI 头角（pre 相位物理输入）：动作播放期让位（manual 来源不让位），写法同 gaze。
    if (FI_ENABLED) applyFacialHead(core);
    injector.apply(core, 'pre');
    // [M1-b] 生产者让位：pre 相位独占参数（Hip*）写入物理让位表；
    // 本钩子返回后、物理 evaluate（Physics600）前生效。flag 关 = 空操作。
    physicsGate.pre(core);
  });
  model.setPostLateUpdateHook((core, deltaTimeSeconds) => {
    phaseDiag.post++;
    // [M1-d2] 手势时间线到期清理旁挂（kfTick 前一行，只插一步纯函数状态清理）：
    // flag 开时 armed 批次全部段到期 → 软解除（releaseKfOwnership 兜底）；flag 关 = 不插，
    // 任何既有相对顺序不变。
    if (TIMELINE_ENABLED) gestureBridge.resolve(performance.now());
    kfTick(performance.now());
    // PR-D：收割非 Loop 动作的真实终点（onFinishedMotionHandler 在 updateMotion 中途只能置标记）
    motionCompletionTick();
    if (!poseOwnedByMotion) {
      poseController.update(core, deltaTimeSeconds, injector);
    }
    applyAmbientFace(core);
    // [M1-b] limb 通道（当前未接 limb deps，flag 关/空表 = 空操作）：
    // resolve 写值经 stagePostWrite 登记，由下一行 injector.apply('post') 后写胜出。
    physicsGate.post(core);
    injector.apply(core, 'post');
    applyGazeEyes(core);
    // [M1-f 第二批] cue 写值必须晚于 applyGazeEyes：gaze 通道写的就是 ParamEyeBallX/Y，
    // 先写会被注视收招覆盖；cue 持有期间以持有值为准（clear/到期后立即交还）。
    if (CUE_ENABLED) applyCueFrame(core);
    // FI 眼（post 相位最后写者）：FI 持有眼参数期间压过注视/天然眨眼，到期让位即恢复。
    if (FI_ENABLED) applyFacialEyes(core, deltaTimeSeconds);
  });

  // 从模型自己的 physics3.json 读取输出表，禁止把无效写入误报为成功。
  const physicsFile = modelSetting?.FileReferences?.Physics;
  if (physicsFile) {
    const { dir } = splitUrl(opts.modelUrl);
    void fetch(dir + physicsFile, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((physics) => {
        const outputs = new Set<string>();
        for (const setting of physics?.PhysicsSettings || []) {
          for (const output of setting?.Output || []) {
            const id = output?.Destination?.Id;
            if (typeof id === 'string') outputs.add(id);
          }
        }
        if (outputs.size) injector.setPhysicsOutputs(outputs);
      })
      .catch(() => {
        /* 保留内置兜底规则 */
      });
  }

  fitModel(canvasEl.width || width, canvasEl.height || height, currentZoom);
  refitLeft = 6;
  startLoop();
}

function waitForModel(timeoutMs: number, earlyErrorRef?: { message: string | null }): Promise<void> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    // 快速失败：lappmodel.loadAssets 检测到模型资源缺失/损坏时派发
    // 'dsh:l2d:model-error'，这里立即 reject，不等 15s 超时空转（P0 修复）。
    let onModelError: ((ev: Event) => void) | null = (ev) => {
      cleanup();
      const detail = (ev as CustomEvent).detail as { message?: string } | undefined;
      reject(new Error(detail?.message || '模型资源加载失败'));
    };
    const cleanup = () => {
      if (onModelError) window.removeEventListener('dsh:l2d:model-error', onModelError);
      onModelError = null;
    };
    window.addEventListener('dsh:l2d:model-error', onModelError);
    const tick = () => {
      if (!onModelError) return; // 已被错误事件 reject，轮询作废
      // [H2] 消费早期错误缓冲（监听器挂载前派发的失败不丢失）
      if (earlyErrorRef && earlyErrorRef.message) {
        cleanup();
        return reject(new Error(earlyErrorRef.message));
      }
      if (model && model.getModel()) {
        cleanup();
        return resolve();
      }
      if (performance.now() - t0 > timeoutMs) {
        cleanup();
        return reject(new Error('模型加载超时'));
      }
      setTimeout(tick, 60);
    };
    tick();
  });
}

let lastTickAt = 0;
let driverTimer = 0;
/** 下一帧的计划时刻（deadline 累加）。0 = 需要重新对齐。 */
let nextTickAt = 0;
/** 上次准入时用的目标帧率：变化时重新对齐 deadline。 */
let gateFps = 0;
/**
 * rAF 间隔估计（ms），用于算「半个 vsync」容差。
 * 初值取 5ms（高刷屏）而不是 16.7ms：初值偏大时 tol 会被钳到上限 8ms，
 * 刚启动的前几帧会提前出帧（约 66fps 的短暂超发）。偏小只会保守等一格，观感更稳。
 */
let vsyncMs = 5;
let lastRafAt = 0;

// ---------------------------------------------------------------- 帧率控制
// 目标是“看得见的稳定 60fps”。只有失焦/页面隐藏才降载，前台不主动降帧，
// 避免出现呼吸、眨眼、物理被 15/10fps 拉慢的观感；这也是用户明确要求的。
let targetFps = 60;
let paused = false;
let pausedByVisibility = false;
let lastActiveAt = typeof performance !== 'undefined' ? performance.now() : 0;

/**
 * 兼容原 API 的外部写入钩子。
 * 实际执行点位于 LAppModel 的 saveParameters 之后、onLateUpdate 之前；
 * 名称保留是为了不破坏 overlay 与既有调用方。
 */
let preUpdateHook: (() => void) | null = null;

export function setPreUpdate(fn: (() => void) | null): void {
  preUpdateHook = fn;
}

// ---------------------------------------------------------------- Emotion_Router
// 情绪路由：传感器信号（鼠标/系统/媒体/<mood>标签）→ 意图 → 现有接口。
// 规则表/词典/优先级都在 emotion-router.ts，这里只做「意图执行器」。
const emotionRouter = new EmotionRouter();
let emotionBubble: ((text: string, holdMs: number) => void) | null = null;
let emotionCloseTimer = 0;

emotionRouter.subscribe((intent) => {
  markActive();
  try {
    if (intent.expression) setExpression(intent.expression);
    if (intent.motion) {
      // 成对动作必须走状态机，不能直接 startMotion，否则 Loop 会卡在半截
      void playMotionAsync(intent.motion, { interrupt: false }).then((result) => {
        if (result.status === 'ok' && intent.motionClose) {
          if (emotionCloseTimer) window.clearTimeout(emotionCloseTimer);
          emotionCloseTimer = window.setTimeout(() => {
            emotionCloseTimer = 0;
            void playMotionAsync(intent.motionClose as string, { interrupt: false });
          }, intent.closeAfterMs ?? 6000);
        }
      });
    }
    if (intent.pose) setPose(intent.pose);
    if (intent.look) lookAt(intent.look.x, intent.look.y);
    if (intent.ambient) startAmbient(intent.ambient);
    if (intent.bubble && emotionBubble) emotionBubble(intent.bubble, 3600);
  } catch {
    /* 意图执行失败不能影响渲染 */
  }
});

/** 情绪信号统一入口：overlay / 宿主 / AI 回流都从这里喂 */
export function emotionSignal(signal: EmotionSignal): void {
  emotionRouter.ingest(signal);
}

/** 注册气泡回调（overlay 的 say()），router 的 bubble 字段由它上屏 */
export function setEmotionBubble(fn: ((text: string, holdMs: number) => void) | null): void {
  emotionBubble = fn;
}

/** 诊断/调试：情绪状态快照 */
export function getEmotionState(): {
  context: string;
  mood: { valence: number; arousal: number };
  diag: string;
} {
  return {
    context: emotionRouter.getContext(),
    mood: { ...emotionRouter.getMood() },
    diag: emotionRouter.diagnostics(),
  };
}

/** 特殊动作链注入口（病娇彩蛋等显式触发的意图，仍走优先级仲裁） */
export function injectEmotionIntent(intent: EmotionIntent): boolean {
  return emotionRouter.injectIntent(intent);
}

/**
 * 动作链优先级门闩。步骤定时仍在 overlay 的 executePokeAction。
 * 这里只回答「能不能占上当前槽」，并给出 start / interrupted 回执。
 */
const actGate = new ActGate();

/**
 * [M1-d2] 手势时间线动作面（flag `embodied.timeline`，默认关 = 现行为逐字节不变）。
 * bridge 持有 timeline 与 armed 批次（纯逻辑在 gesture-bridge.ts，可 node 单测）；
 * renderer 只负责把 ActGate / injector / keyframes 播放器作为 deps 注入。
 * 回滚 = 把 DEFAULT_EMBODIED_FLAGS['embodied.timeline'] 保持/改回 false。
 */
const TIMELINE_ENABLED = DEFAULT_EMBODIED_FLAGS['embodied.timeline'] === true;
const gestureBridge = createGestureBridge({
  enabled: TIMELINE_ENABLED,
  currentAct: () => actGate.current(),
  getAgentOwned: () => injector.getAgentOwned(),
  releaseOwned: (ids) => injector.release(ids),
  stopKeyframes: () => stopKeyframes(),
  releaseKfOwnership: () => releaseKfOwnership(),
});

/**
 * [M1-f 第二批] EmbodiedCue 行为闭环（flag `embodied.cue`，默认关）。
 * 前置依赖 embodied.timeline 作为 hold/transition 的准入闸：timeline 关 → cue 整体 disabled
 * （不编译、不入队、不写值，回滚 = 两个 flag 任一置 false）。
 * 纯逻辑在 cue-bridge.ts（可 node 单测），这里只注入运行面（时间线/表情/时钟）。
 */
const CUE_ENABLED =
  DEFAULT_EMBODIED_FLAGS['embodied.cue'] === true && TIMELINE_ENABLED;
/** 本帧模型引用（cue 写值端口在帧钩子里取；模块级同 model/canvasEl 的既有装配方式）。 */
let cueFrameCore: CoreModel | null = null;
const CUE_MOUTH_PARAMS = new Set<string>(LIPSYNC_PARAMS);
const cueBridge = createCueBridge({
  enabled: CUE_ENABLED,
  admitGesture: (segments, opts) =>
    gestureBridge.admit(segments as GestureSegmentInput[], { entryId: opts?.entryId }),
  stopGesture: (selector) => gestureBridge.stop(selector),
  setExpression: (name) => setExpression(name),
  clearExpression: () => clearExpression(),
  knownOverlays: () =>
    modelSetting?.FileReferences?.Expressions?.map((e) => e?.Name ?? '').filter((n) => !!n),
  // 唯一写通道：ParamInjector（口型/物理未授权/真实下标/钳制/计数全部复用其守卫）。
  writeParam: (id, value) => {
    if (!cueFrameCore) return false;
    return injector.applyNow(cueFrameCore, [{ id, value }], { mode: 'set' }).applied.length === 1;
  },
  isMouthParam: (id) => CUE_MOUTH_PARAMS.has(id),
  isPhysicsOutput: (id) => injector.isPhysicsOutput(id),
  ownParams: (ids, durationMs, phase) => injector.own(ids, durationMs, phase),
  releaseOwned: (ids) => injector.release(ids),
});

/**
 * [M1-d2] 手势准入（overlay l2d_act / l2d_play_keyframes 前置调用）。
 * flag 关时恒 rejected('disabled') 且 flagEnabled:false —— overlay 以
 * `ga.admitted === false && ga.flagEnabled` 判定拒绝，否则等价直通原路径（兼容矩阵 §6）。
 */
export function admitGesture(
  segments: GestureSegmentInput[],
  opts: GestureAdmitOptions = {},
) {
  const admission = gestureBridge.admit(segments, opts);
  if (admission.admitted) markActive();
  return admission;
}

/** [M1-d2] 显式释放手势；selector 缺省 = 全停（透传 core stopGesture 语义）。 */
export function stopGesture(selector?: StopSelector) {
  return gestureBridge.stop(selector);
}

/** [M1-d2] 诊断只读面。 */
export function getGestureState(): GestureBridgeSnapshot {
  return gestureBridge.snapshot();
}

/**
 * [M1-f 第二批] EmbodiedCue 准入（hold/transition/overlay/clear）。
 *
 * 判定顺序：flag 查 → compileEmbodiedCue fail-closed 校验 → 表情清单校验 →
 * 时间线准入（同通道替换/跨通道并存/低不打断高，沿用 enqueueGesture）→ 落账。
 * 返回 accepted=false 且 flagEnabled=true 表示被拒（与 admitGesture 同口径）。
 */
export function admitCue(cue: EmbodiedCue, opts: { runId?: string; entryId?: string } = {}) {
  const admission = cueBridge.admit(cue, opts);
  if (admission.accepted) markActive();
  return admission;
}

/** [M1-f 第二批] 显式释放 cue（selector 缺省 = 全清；按 channel/runId/overlay 收窄）。 */
export function stopCue(selector?: CueReleaseSelector): CueStopOutcome {
  return cueBridge.stop(selector);
}

/** [M1-f 第二批] 诊断只读面。 */
export function getCueState(): CueBridgeSnapshot {
  return cueBridge.snapshot();
}

export function admitAct(input: ActAdmitInput = {}) {
  const result = actGate.admit(input);
  // [M1-d2] Agent 打断手势：flag 开且链占上槽时全清时间线 + 停旧手势逐帧写值
  // （FORCE 戳一戳同样能打断手势——Agent/交互动作占用身体时手势让位）。
  // flag 关 = 与基线完全一致（admitGesture/armed 均不可达）。
  if (TIMELINE_ENABLED && result.accepted) {
    gestureBridge.stop();
    // [M1-f 第二批] Agent 动作占用身体时 cue 一并让位（同 admitGesture 的打断语义）。
    if (CUE_ENABLED) cueBridge.stop();
  }
  return result;
}

export function finishAct(runId: number, endReason?: string) {
  return actGate.finish(runId, endReason);
}

export function releaseAct(runId?: number, reason?: string) {
  return actGate.release(runId, reason);
}

export function currentAct() {
  return actGate.current();
}

export function actPhaseTemplate(name: string): ActPhaseTemplate | null {
  return getActPhaseTemplate(name);
}

export function noteActMotion(runId: number, reason: string, kind?: 'fail' | 'skip'): void {
  if (!runId || !reason) return;
  actGate.noteMotion(runId, reason, kind === 'skip' ? 'skip' : 'fail');
}

export { countRealCompletions };

// ---------------------------------------------------------------- 真实完成事件（PR-D）
//
// 裁决书「不得预估时长」：完成信号只来自运行时真实终点——
//   motion    : Cubism onFinishedMotionHandler（非 Loop 自然收敛；Loop 无终点不产事件）
//   keyframes : kfTick 的 elapsed >= kfDuration 收敛（非 loop）
// overlay 订阅后按 executionId（=/ai/call 的 callId）转发 ai-inbox 事件通道；
// HttpActionExecutor 消费真实事件并做 ownership 出口核对（详见 action-executor.mjs）。
const actionCompletionBus = createCompletionBus();

/** 订阅真实完成事件；返回退订函数。监听方异常不反噬渲染。 */
export const onActionCompletion = (cb: (event: ActionCompletionEvent) => void): (() => void) =>
  actionCompletionBus.subscribe(cb);

/** 派发真实完成事件；executionId 缺失时不产事件（无消费者可关联，纯噪音）。
 *  三态生命周期（PR-A）：phase 必须区分 end/interrupted/failed，不得统一当作 completed。 */
function emitActionCompletion(
  kind: 'motion' | 'keyframes',
  executionId: string,
  group: string,
  owned: string[],
  phase: 'end' | 'interrupted' | 'failed' = 'end',
  reason?: string,
): void {
  if (!executionId) return;
  const event: ActionCompletionEvent = { kind, executionId, group, phase, owned };
  if (reason) event.reason = reason;
  actionCompletionBus.emit(event);
}

export { closeMotionsOnPreempt, preemptedYandere, motionsShareArm, motionResultKind };

/** 动作诊断，不参与渲染决策。 */
let motionDiag = { group: 'none', startedAt: 0, playing: false };
/** playMotionAsync 的收招定时器（Loop 动作回卷前收养终态姿势）；reset 必须能撤掉它。 */
let motionStopTimer = 0;
/**
 * PR-D：非 Loop 动作的真实终点待处理标记。onFinishedMotionHandler 在 updateMotion
 * 中途触发，不能就地改动作队列/姿势层；置为待处理闭包，由 postLateUpdate 钩子在
 * 同帧 update 结束后统一收割（motionCompletionTick）。
 */
let motionFinishPending: (() => void) | null = null;
/** 本次动作的完成是否已收割（自然收敛与看门狗兜底双路径，防双发完成事件）。 */
let motionCompletionDone = false;
/** PR-D：postLateUpdate 相位收割待处理的真实终点（不能在 updateMotion 中途改队列/姿势）。 */
function motionCompletionTick(): void {
  const harvest = motionFinishPending;
  if (!harvest) return;
  motionFinishPending = null;
  harvest();
}
/**
 * 动作纪元：reset 递增。旧动作的收招定时器看到纪元变化即自行作废，
 * 避免 reset 之后 adoptAfterMotion 又把终态姿势（如 finger）收养回来。
 */
let motionEpoch = 0;
/**
 * awaitFinish 等待者登记：playMotionAsync(opts.awaitFinish) 创建的 finishResolve。
 * completeMotion 的各终点路径会放行并移除；resetPerformance 会清掉 completeMotion 的
 * 全部触发路径（停定时器 + motionFinishPending=null + 纪元递增），若不放行，等待方的
 * finished promise 永久挂起（playMotionAsync 的 await finished 永不返回）。
 */
const pendingFinishResolvers = new Set<() => void>();
/** 动作播放期间姿势层让位；Loop 动作靠定时器交还。 */
let poseOwnedByMotion = false;

// ---------------------------------------------------------------- Facial Intelligence（PR-01）
// 链路：LLM/手动 → FacialBridge（验证/仲裁/平滑，纯逻辑）→ 本文件在正确相位经 injector 写入。
// 不复写 Cubism；口型红线不触碰（见 docs/facial-intelligence/DEVIATION-REPORT.md）。
const FI_ENABLED = true;
const facialBridge = new FacialBridge();
/** 最近一帧 FI 输出：post 钩子 tick 产出，pre 钩子用它写头角（一帧延迟可接受）。 */
let facialFrameCache: FacialFrame | null = null;
const FI_SEMANTICS: readonly FacialSemantic[] = [
  'head.yaw', 'head.pitch', 'head.roll',
  'eyes.leftOpen', 'eyes.rightOpen', 'eyes.gazeX', 'eyes.gazeY',
];
/** 注入相位诊断：确认 pre/post 钩子都在跑。 */
const phaseDiag = { pre: 0, post: 0 };
let windowFocused = true;

/** 标记"有交互"：拖拽、点击、AI 指令、动作播放都会调它，确保前台满帧 */
export function markActive(): void {
  lastActiveAt = performance.now();
  if (!paused) targetFps = 60;
}

/** 当前应使用的帧率：前台恒定 60；失焦降载 30；最近有交互保持 60 */
function computeFps(_now: number): number {
  if (kfActive) return 60;
  // 交互后 2.5s 内保持满帧：鼠标进窗/切回前台立刻顺滑，不用等降载窗口回升
  if (performance.now() - lastActiveAt < 2500) return 60;
  if (!windowFocused) return 30; // 失焦降载 30fps（原 15fps 实测只有 9.5，观感卡）
  return 60;
}

function tick(): void {
  if (paused) return;
  const now = performance.now();
  targetFps = computeFps(now);
  const interval = 1000 / targetFps;
  // 帧率上限用 deadline 累加，而不是「距上次出帧多久」。
  // 后者在高刷屏上会被 rAF 量化：200Hz 每 5ms 一格，60fps 的 16.67ms 只能取到 20ms，
  // 上限被钉在 refreshHz/ceil(refreshHz/capHz) = 200/4 = 50fps（实测 49.6）。
  // 首帧 / 目标档位变化 / 长挂起后重新对齐，避免追补一串补帧。
  if (nextTickAt <= 0 || targetFps !== gateFps || now - nextTickAt > interval * 2) {
    nextTickAt = now;
    gateFps = targetFps;
  }
  // 半个 vsync 容差：容许提前不到一格出帧，200Hz 上出帧间隔自然形成 15/20ms 交替，
  // 平均 16.67ms；60Hz 屏容差更小，不会多出帧。
  const tol = Math.min(Math.max(vsyncMs / 2, 1), 8);
  if (now + tol < nextTickAt) return;
  nextTickAt = Math.max(nextTickAt, now) + interval; // 严重迟到时不补帧爆发
  lastTickAt = now;
  syncStageGate();
  emotionRouter.tick(Date.now()); // 情绪路由心跳（内部自带 200ms 限频）
  if (!sub) return;

  // 推进帧时间。Cubism 的动作、物理、呼吸、眨眼全部依赖 LAppPal.getDeltaTime()；
  // 官方 demo 在启动器的每帧循环里调用 updateTime()，我们自己接管循环时也必须调，
  // 否则 deltaTime 恒为 0 —— 模型画得出来，但永远静止不动。
  LAppPal.updateTime();
  // 长时间挂起（切标签页、休眠）后恢复时步长会很大，会让动作瞬移、物理爆炸，做一次钳制
  const dt = LAppPal.getDeltaTime();
  if (!(dt > 0) || dt > 0.1) LAppPal.deltaTime = 0.016;
  const stepDt = dt > 0 && dt <= 0.1 ? dt : 0.016;
  gazeFrame(stepDt);
  updateAmbient(stepDt);

  try {
    sub.update();
    // 命中采样改为事件驱动 + 10Hz 节流（readPixels 是 GPU→CPU 同步，不能每帧做）
    maybeSampleHitProbe(now);
    frames++;
    // 首帧的部件可见性/不透明度可能还没稳定，包围盒会偏。跑几帧后重排一次。
    if (refitLeft > 0) {
      refitLeft--;
      if (refitLeft === 0 && lastFit.w > 0) fitModel(lastFit.w, lastFit.h, currentZoom);
    }
  } catch (err) {
    if (!lastError) lastError = err && (err as Error).message ? (err as Error).message : String(err);
  }
}

function startLoop(): void {
  if (rafId) return;

  const rafLoop = (ts: number) => {
    rafId = requestAnimationFrame(rafLoop);
    // 实测 rAF 间隔 = 显示刷新周期（200Hz 屏 5ms、60Hz 16.7ms），用来算半个 vsync 容差。
    // 只接受合理区间，避免偶发掉帧把估计拉长；指数平滑，收敛约 0.5s。
    if (lastRafAt > 0) {
      const gap = ts - lastRafAt;
      if (gap > 1 && gap < 40) vsyncMs = vsyncMs * 0.8 + gap * 0.2;
    }
    lastRafAt = ts;
    tick();
  };
  rafId = requestAnimationFrame(rafLoop);

  // rAF 在后台标签页、被遮挡窗口、部分内嵌浏览器里会被节流甚至完全暂停。
  // 这种情况下模型解析成功却一帧都画不出来（表现为画布全透明）。
  // 兜底：超过 250ms 没推进就用定时器补帧；rAF 恢复后自动让位。
  if (!driverTimer) {
    driverTimer = window.setInterval(() => {
      if (!paused && performance.now() - lastTickAt > 250) {
        nextTickAt = 0; // 兜底补帧后重新对齐 deadline，别让旧计划拖住
        tick();
      }
    }, 66);
  }

  installSchedulingGuards();
}

/**
 * 调度守卫：页面隐藏就停、窗口失焦就降频。
 *
 * 不做这件事的后果很实在：
 *   - 用户最小化窗口后角色还在满帧渲染，笔记本风扇狂转
 *   - DSH 里开着角色去用别的软件，GPU 一直被占着
 */
function installSchedulingGuards(): void {
  if ((window as unknown as { __DSH_L2D_GUARD__?: boolean }).__DSH_L2D_GUARD__) return;
  (window as unknown as { __DSH_L2D_GUARD__?: boolean }).__DSH_L2D_GUARD__ = true;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pausedByVisibility = true;
      paused = true;
    } else if (pausedByVisibility) {
      pausedByVisibility = false;
      paused = false;
      lastTickAt = 0; // 立即补一帧，避免恢复时画面停住
      nextTickAt = 0; // 同步重置 deadline，否则旧计划会把补帧挡回去
      gateFps = 0;
      markActive(); // 回前台立即满帧（不等降载窗口回升）
    }
  });

  window.addEventListener('blur', () => {
    windowFocused = false;
  });
  window.addEventListener('focus', () => {
    windowFocused = true;
    markActive();
  });
  // 鼠标进入窗口即视为活跃：失焦降载期间移进窗口也立刻回满帧
  window.addEventListener('pointerenter', markActive, { passive: true });
  // 任何指针活动都算交互，避免「只是在角色上移一下」就掉到低帧
  window.addEventListener('pointerdown', markActive, { passive: true });
  window.addEventListener('wheel', markActive, { passive: true });
}

export function layout(width: number, height: number, zoom = 1, dpr = 0): void {
  if (!sub || !canvasEl) return;
  // CSS 尺寸与画布分辨率分开：分辨率 = CSS × 倍率，由 subdelegate 统一钳到 8K 上限
  sub.renderScale = clampRenderScale(dpr);
  canvasEl.style.width = width + 'px';
  canvasEl.style.height = height + 'px';
  currentZoom = zoom;
  sub.onResize();
  fitModel(canvasEl.width, canvasEl.height, zoom);
}

// ---------------------------------------------------------------- 关键帧播放器
//
// 让 AI 自己「编排动作」的入口：给一组 (参数, 时间→值) 轨道，运行时线性插值写参数。
//
// 为什么要有硬限制（轨道数 / 关键帧数 / 时长 / 值域）：
//   AI 很容易一次吐出几百条轨道，或者给出 1e6 这种值。没有护栏的话，
//   轻则模型姿势扭曲，重则每帧写上百个参数把帧率拖垮。
//   这里统一钳到参数自身范围内，并限制规模，保证「编错了也不会炸」。

export interface KeyframeTrack {
  /** 参数名，必须真实存在 */
  param: string;
  /** [[时间ms, 值], ...]，按时间递增 */
  keys: Array<[number, number]>;
}

export interface KeyframesOptions {
  /** 总时长 ms；缺省取所有轨道最大时间 */
  duration?: number;
  loop?: boolean;
  /** PR-D：完成事件关联键（=/ai/call 的 callId）。缺省不产出完成事件。 */
  executionId?: string | number;
}

interface KfTrackRuntime {
  handle: { getString: () => string };
  min: number;
  max: number;
  keys: Array<[number, number]>;
}

let kfTracks: KfTrackRuntime[] = [];
let kfStart = 0;
let kfDuration = 0;
let kfLoop = false;
let kfActive = false;
/** 关键帧自动认领的物理输出参数（播放结束/停止时释放，不碰调用方自己 own 的） */
let kfAutoOwned: string[] = [];
/** 本次 keyframes 涉及的、已被 ownership 覆盖的物理输出（回执用，含调用方原本就 own 的） */
let kfOwnedForTracks: string[] = [];
let kfRenewAt = 0;
/** PR-D：本次 keyframes 的完成事件关联键（executionId 关联） */
let kfExecutionId = '';

function releaseKfOwnership(): void {
  if (!kfAutoOwned.length) return;
  injector.release(kfAutoOwned);
  kfAutoOwned = [];
  kfOwnedForTracks = [];
  kfRenewAt = 0;
}

const KF_MAX_TRACKS = 8;
const KF_MAX_KEYS = 32;
const KF_MAX_MS = 10000;
/** 口型禁区：关键帧任何调用方都不得写口型参数，统一在轨道准入处拦截。 */
const LIPSYNC_BLOCK = new Set<string>(LIPSYNC_PARAMS);

function sampleTrack(keys: Array<[number, number]>, t: number): number {
  if (!keys.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const span = t1 - t0;
      if (span <= 0) return v1;
      return v0 + ((v1 - v0) * (t - t0)) / span;
    }
  }
  return last[1];
}

/**
 * 播放一段关键帧动画。
 * @returns 实际生效的轨道数；0 表示没有任何合法轨道（参数全不存在或数据非法）
 */
export function playKeyframes(tracks: KeyframeTrack[], opts: KeyframesOptions = {}): number {
  if (!model) return 0;
  const core = model.getModel();
  if (!core) return 0;

  const accepted: KfTrackRuntime[] = [];
  let maxT = 0;

  for (const tr of (tracks || []).slice(0, KF_MAX_TRACKS)) {
    if (!tr || !tr.param || !Array.isArray(tr.keys) || tr.keys.length < 2) continue;
    // [M1-d2] 纵深防御 #3：flag 开时，写物理输出的轨道必须有 armed 批次背书
    // （admitGesture/l2d_act keyframes 步登记）。没有 armed 批次的物理轨道写不进去 =
    // 即使未来新增直连调用方也踩不掉 Agent 持有的手臂。flag 关时 TIMELINE_ENABLED
    // 为编译期常量 false，本分支不可达，playKeyframes 逐行为等价基线。
    if (TIMELINE_ENABLED && injector.isPhysicsOutput(tr.param) && !gestureBridge.armedHas(tr.param)) {
      continue;
    }
    try {
      const handle = CubismFramework.getIdManager().getId(tr.param);
      const idx = core.getParameterIndex(handle);
      // 准入只排除「参数不存在 / 口型红线」；物理输出照收，准入后统一自动认领
      // （之前把 isAgentOwned 判断放在自动 own 之前，导致未预先 own 的物理输出轨道
      //   被整条丢弃，playKeyframes 直接返回 no-valid-tracks）。
      const admission = admitKeyframeTrack({
        exists: idx >= 0,
        lipsync: LIPSYNC_BLOCK.has(tr.param),
        physicsOutput: injector.isPhysicsOutput(tr.param),
      });
      if (!admission.accepted) continue;

      const min = core.getParameterMinimumValue(idx);
      const max = core.getParameterMaximumValue(idx);

      const keys: Array<[number, number]> = tr.keys
        .slice(0, KF_MAX_KEYS)
        .map((k) => {
          const t = Math.max(0, Math.min(KF_MAX_MS, Number(k[0]) || 0));
          const v = Math.max(min, Math.min(max, Number(k[1]) || 0));
          return [t, v] as [number, number];
        })
        .sort((a, b) => a[0] - b[0]);

      maxT = Math.max(maxT, keys[keys.length - 1][0]);
      accepted.push({ handle, min, max, keys });
    } catch {
      /* 单条轨道异常忽略 */
    }
  }

  if (!accepted.length) return 0;

  // 关键帧跨越所有权 TTL 时后半段会被 injector 当回物理输出拒掉：
  // 这里按轨道时长自动认领（loop 时在 kfTick 里续期），播放结束/停止再释放。
  releaseKfOwnership();
  const ownedNow: string[] = [];
  const ownedForTracks: string[] = [];
  const ttl = Math.max(16, Math.min(KF_MAX_MS, Number(opts.duration) || maxT)) + 600;
  for (const tr of accepted) {
    const id = tr.handle.getString();
    if (!injector.isPhysicsOutput(id)) continue;
    const already = injector.isAgentOwned(id);
    injector.own([id], ttl);
    ownedForTracks.push(id);
    if (!already) ownedNow.push(id);
  }

  kfTracks = accepted;
  kfDuration = Math.max(16, Math.min(KF_MAX_MS, Number(opts.duration) || maxT));
  kfLoop = !!opts.loop;
  kfExecutionId = opts.executionId == null ? '' : String(opts.executionId);
  kfStart = performance.now();
  kfActive = true;
  kfAutoOwned = ownedNow;
  kfOwnedForTracks = ownedForTracks;
  kfRenewAt = kfStart + Math.max(400, kfDuration / 2);
  markActive();
  return accepted.length;
}

/** 当前 keyframes 占用的物理输出（回执用；播放结束/停止后清空）。 */
export function getKeyframeOwnedParameters(): string[] {
  return kfOwnedForTracks.slice();
}

export function stopKeyframes(): void {
  // PR-A 三态：飞行中的被追踪执行被显式停止 → interrupted（非 completed）。
  // owned 必须在释放前快照，与自然收敛同一份出口核对语义。
  if (kfActive && kfExecutionId) {
    const owned = kfOwnedForTracks.slice();
    emitActionCompletion('keyframes', kfExecutionId, '', owned, 'interrupted', 'stop-called');
  }
  kfActive = false;
  kfTracks = [];
  kfExecutionId = '';
  releaseKfOwnership();
}

function kfTick(now: number): void {
  if (!kfActive) return;
  const core = model?.getModel();
  if (!core) {
    kfActive = false;
    return;
  }

  const elapsed = now - kfStart;
  const t = kfLoop ? elapsed % kfDuration : Math.min(elapsed, kfDuration);

  for (const tr of kfTracks) {
    let v = sampleTrack(tr.keys, t);
    v = Math.max(tr.min, Math.min(tr.max, v));
    try {
      injector.set(core, tr.handle.getString(), v, 1);
    } catch {
      /* ignore */
    }
  }

  if (!kfLoop && elapsed >= kfDuration) {
    kfActive = false;
    // PR-D：真实完成事件。owned 必须在释放前快照（releaseKfOwnership 会清空清单），
    // 出口核对语义：完成时刻仍被认领的物理输出，理想应为空（本次 auto-owned 已释放）。
    const owned = kfOwnedForTracks.slice();
    releaseKfOwnership();
    emitActionCompletion('keyframes', kfExecutionId, '', owned);
    kfExecutionId = '';
    return;
  }
  // loop 长时间播放：到期前续期，避免后半段被 injector 拒写
  if (kfLoop && kfAutoOwned.length && now >= kfRenewAt) {
    injector.own(kfAutoOwned, kfDuration + 600);
    kfRenewAt = now + Math.max(400, kfDuration / 2);
  }
}

// ---------------------------------------------------------------- 控制接口
//
// 重要：Cubism 5 的 setParameterValueById(id) 要求 CubismIdHandle，内部会调 id.getString()。
// 直接传字符串会抛异常 —— 旧实现把异常吞掉了，表现为「调用成功但模型毫无反应」。
// 这里统一走 getIdManager().getId()，并且先用 getParameterIndex 校验参数是否真的存在，
// 避免把值写进一个自动新建的空 ID 上。

function handleOf(id: string): ReturnType<ReturnType<typeof CubismFramework.getIdManager>['getId']> | null {
  try {
    return CubismFramework.getIdManager().getId(id);
  } catch {
    return null;
  }
}

const clamp = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/**
 * AngleZ / PositionX / PositionY 的三路加法。
 * body：拖拽或 setParameters；ambient：待机微动作；media：媒体律动。
 * 优先级 body > ambient > media，超出幅度从低优先级往下砍。
 */
// AngleZ 上限对齐模型输入范围 ±30（S1-RACE：验收契约 setParameter('AngleZ',20)
// 要求原值生效，15 的旧上限会把 agent 直写削成 15）。混控保护语义不变。
const ANGLE_BUS_CAP = { AngleZ: 30, PositionX: 10, PositionY: 10 } as const;
type BusParam = keyof typeof ANGLE_BUS_CAP;
type BusChannel = 'body' | 'gaze' | 'ambient' | 'media';
const angleBus: Record<BusParam, Record<BusChannel, number>> = {
  AngleZ: { body: 0, gaze: 0, ambient: 0, media: 0 },
  PositionX: { body: 0, gaze: 0, ambient: 0, media: 0 },
  PositionY: { body: 0, gaze: 0, ambient: 0, media: 0 },
};
const angleBusLive: Record<BusParam, boolean> = { AngleZ: false, PositionX: false, PositionY: false };
const missingAmbient = new Set<string>();

function paramExists(core: CoreModel, id: string): boolean {
  // 真实下标校验（真机缺陷：Cubism 5 getParameterIndex 对不存在参数返回合成下标，
  // 旧的 `getParameterIndex(handle) >= 0` 恒真）。见 param-injector.ts 的 parameterIndexOf。
  return parameterIndexOf(core, id) >= 0;
}

function zeroAngleBus(): void {
  (Object.keys(angleBus) as BusParam[]).forEach((id) => {
    angleBus[id].body = 0;
    angleBus[id].gaze = 0;
    angleBus[id].ambient = 0;
    angleBus[id].media = 0;
    angleBusLive[id] = false;
  });
}

function flushAngleBus(core: CoreModel): void {
  applyMediaLayer();
  (Object.keys(ANGLE_BUS_CAP) as BusParam[]).forEach((id) => {
    const row = angleBus[id];
    const sum = mixAdditive(
      [
        { id: 'body', priority: 40, value: row.body },
        { id: 'gaze', priority: 35, value: row.gaze },
        { id: 'ambient', priority: 20, value: row.ambient },
        { id: 'media', priority: 10, value: row.media },
      ],
      ANGLE_BUS_CAP[id],
    );
    if (sum === 0) {
      if (angleBusLive[id]) {
        injector.clear([id]);
        angleBusLive[id] = false;
      }
      return;
    }
    if (!paramExists(core, id) || injector.isPhysicsOutput(id)) {
      if (!missingAmbient.has(id)) {
        missingAmbient.add(id);
        console.info('[dsh-l2d] 参数不存在或是物理输出，已跳过: ' + id);
      }
      return;
    }
    injector.set(core, id, sum, 1);
    angleBusLive[id] = true;
  });
}

const stageBusy = { dragging: false, acting: false };

function syncStageGate(): void {
  emotionRouter.setGate({
    drag: stageBusy.dragging,
    acting: stageBusy.acting,
    media: mediaState.on,
    motion: poseOwnedByMotion || isUserMotionPlaying(),
  });
}

/** 拖拽缩放、戳一戳动作链进行时通知渲染端，微动作让路。 */
export function setStageBusy(flags: { dragging?: boolean; acting?: boolean }): void {
  if (typeof flags.dragging === 'boolean') stageBusy.dragging = flags.dragging;
  if (typeof flags.acting === 'boolean') stageBusy.acting = flags.acting;
  if (stageBusy.dragging || stageBusy.acting) stopAmbient();
  syncStageGate();
}

interface AmbientPlay {
  kind: AmbientKind;
  sign: number;
  elapsed: number;
  duration: number;
}

let ambientPlay: AmbientPlay | null = null;
const AMBIENT_SEC = 2.4;

function startAmbient(kind: AmbientKind): void {
  if (stageBusy.dragging || stageBusy.acting || mediaState.on || poseOwnedByMotion || isUserMotionPlaying()) {
    return;
  }
  ambientPlay = {
    kind,
    sign: Math.random() < 0.5 ? -1 : 1,
    elapsed: 0,
    duration: AMBIENT_SEC,
  };
}

function stopAmbient(): void {
  ambientPlay = null;
  angleBus.AngleZ.ambient = 0;
  angleBus.PositionX.ambient = 0;
  angleBus.PositionY.ambient = 0;
  ambientFace = {};
}

let ambientFace: Record<string, number> = {};
let ambientFaceArmed = false;

function updateAmbient(dt: number): void {
  const blocked =
    stageBusy.dragging || stageBusy.acting || mediaState.on || poseOwnedByMotion || isUserMotionPlaying();
  if (!ambientPlay || blocked) {
    if (ambientPlay && blocked) stopAmbient();
    else {
      angleBus.AngleZ.ambient = 0;
      angleBus.PositionX.ambient = 0;
      angleBus.PositionY.ambient = 0;
      if (!ambientPlay) ambientFace = {};
    }
    return;
  }
  ambientPlay.elapsed += dt;
  const t = ambientPlay.elapsed / ambientPlay.duration;
  if (t >= 1) {
    stopAmbient();
    return;
  }
  const sample = sampleAmbient(ambientPlay.kind, t, ambientPlay.sign);
  angleBus.AngleZ.ambient = sample.AngleZ || 0;
  angleBus.PositionX.ambient = sample.PositionX || 0;
  angleBus.PositionY.ambient = sample.PositionY || 0;
  ambientFace = {};
  if (sample.CheeckPuff) ambientFace.CheeckPuff = sample.CheeckPuff;
  if (sample.Mouthpucker) ambientFace.Mouthpucker = sample.Mouthpucker;
}

function applyAmbientFace(core: CoreModel): void {
  const ids = ['CheeckPuff', 'Mouthpucker'];
  let wrote = false;
  for (const id of ids) {
    const value = ambientFace[id];
    if (!(value > 0.001)) continue;
    if (injector.isPhysicsOutput(id) || !paramExists(core, id)) {
      if (!missingAmbient.has(id)) {
        missingAmbient.add(id);
        console.info('[dsh-l2d] 微表情参数不存在，已跳过: ' + id);
      }
      continue;
    }
    injector.set(core, id, value, 1);
    wrote = true;
  }
  if (wrote) {
    ambientFaceArmed = true;
    return;
  }
  // 微表情结束后清掉粘滞值，避免腮帮子一直鼓着，也避免每帧去清别人写的参数
  if (ambientFaceArmed) {
    injector.clear(ids);
    ambientFaceArmed = false;
  }
}

/**
 * 设置单个参数并逐帧保持；成功返回 null，失败返回 reason。
 * 参数不存在或是物理输出都会被拒——不存在的参数绝不静默 applied。
 * 写入会在下一个正确的帧相位生效，而不是在这里直接改 Core。
 *
 * 真机缺陷修复（choreo 复现：真机 l2d_set_parameters 写 ParamArmRA / ParamNotExistXYZ
 * 都回报 applied）。根因与整体校验见 param-injector.ts 的 parameterIndexOf 注释；
 * 这里在入口再挡一道并给出 reason，让回执 failed 里能带原因。
 * 真机复现步骤：真机调 l2d_set_parameters { values: { ParamArmRA: 1, ParamNotExistXYZ: 1 } }，
 * 修复前两者都在 applied；修复后都进 failed 且 reason=not-exist
 * （本模型真实手臂参数是 Param36/39/40/41/42/43 与 59~62）。
 */
function setParameterChecked(id: string, value: number, weight = 1, channel: 'agent' | 'runtime' = 'agent'): string | null {
  const core = model?.getModel();
  if (!core) return 'not-ready';
  const num = Number(value);
  if (!Number.isFinite(num)) return 'invalid-value';
  // Node Ownership：外部（agent）通道只允许写托管白名单内的参数；
  // runtime 通道（UI 本地交互）不受白名单约束，口型红线仍由 injector 更早优先拒绝。
  if (channel === 'agent' && !isHostable(id)) return 'not_hostable';
  // AngleZ / PositionX / PositionY 可能被拖拽、微动作、媒体同时写，先记账再统一注入
  if (id === 'AngleZ' || id === 'PositionX' || id === 'PositionY') {
    if (!paramExists(core, id)) return 'not-exist';
    if (injector.isPhysicsOutput(id)) return 'physics-output';
    angleBus[id].body = num;
    return null;
  }
  // 入口校验：不存在 → not-exist；物理输出未独占 → physics-output（与 injector.set 同判）
  if (!paramExists(core, id)) return 'not-exist';
  return injector.set(core, id, num, weight, { channel }) ? null : 'rejected';
}

export function setParameter(id: string, value: number, weight = 1): boolean {
  return setParameterChecked(id, value, weight) === null;
}

export interface ApplyReport {
  ok: string[];
  /** 失败项：`参数名:reason`（not-exist / not_hostable / physics-output / mouth-locked / invalid-value / not-ready / rejected） */
  failed: string[];
}

/** 批量设置参数（AI 一次返回多个参数时用） */
export function setParameters(values: Record<string, number>, weight = 1): ApplyReport {
  const ok: string[] = [];
  const failed: string[] = [];
  const src = values || {};
  for (const key of Object.keys(src)) {
    const reason = setParameterChecked(key, src[key], weight, 'agent');
    if (reason === null) ok.push(key);
    else failed.push(key + ':' + reason);
  }
  return { ok, failed };
}

/**
 * runtime 通道批量写：UI 本地交互（拖拽倾斜/位移、换装/配饰开关等）专用。
 * 不受 Node Ownership 托管白名单约束（白名单管 Agent/AI 控制权，UI 交互属
 * runtime 域）；口型红线与物理输出保护依然生效。
 */
export function setParametersRuntime(values: Record<string, number>, weight = 1): ApplyReport {
  const ok: string[] = [];
  const failed: string[] = [];
  const src = values || {};
  for (const key of Object.keys(src)) {
    const reason = setParameterChecked(key, src[key], weight, 'runtime');
    if (reason === null) ok.push(key);
    else failed.push(key + ':' + reason);
  }
  return { ok, failed };
}

/**
 * Agent 独占参数：允许写物理输出，并且只在 ownership 指定的相位写入
 * （叶子四肢 post，Physics600 之后后写胜出），同一参数同一帧只有一条写入路径。
 * 只有物理输出会被登记；非物理参数请走普通 setParameters（保持 add/set 语义）。
 * 到期自动释放，不写永久状态。
 * @param ids 参数名
 * @param durationMs 占用时长（毫秒，<=0 表示长期持有），缺省 1200ms
 * @param phase 缺省 post；Hip 类参数 M1-b 用 pre
 * @returns 实际登记的 id（非物理输出会被忽略）
 */
export function ownParameters(ids: string[], durationMs = 1200, phase: 'pre' | 'post' = 'post'): string[] {
  if (!model?.getModel()) return [];
  markActive();
  // agent 通道：只允许认领托管白名单内的参数（defaultOwnership='none'）
  return injector.own(ids, durationMs, phase, { channel: 'agent' });
}

/** 主动释放 Agent 独占；下一帧物理自然接管，不需要恢复逻辑。 */
export function releaseParameters(ids: string[]): string[] {
  return injector.release(ids);
}

/** 诊断用：当前被 Agent 独占的参数。 */
export function getOwnedParameters(): string[] {
  return injector.getAgentOwned();
}

/** 视线/头部朝向，x、y ∈ [-1, 1]，走模型自带的拖动逻辑（Angle/EyeBall 一起动） */
export function lookAt(x: number, y: number): void {
  markActive();
  if (!model) return;
  const core = model.getModel();
  if (!core) return;

  const px = clamp(Number(x) || 0);
  const py = clamp(Number(y) || 0);

  // 以默认值为中点、按参数自身范围映射归一化值
  const writeNormalized = (paramId: string, normalized: number): boolean => {
    try {
      // 真实下标校验（合成下标 ≠ 存在，见 param-injector.ts parameterIndexOf 注释）
      const idx = parameterIndexOf(core, paramId);
      if (idx < 0) return false;
      const handle = CubismFramework.getIdManager().getId(paramId);
      const min = core.getParameterMinimumValue(idx);
      const max = core.getParameterMaximumValue(idx);
      const def = core.getParameterDefaultValue(idx);
      const value =
        normalized >= 0 ? def + (max - def) * normalized : def + (def - min) * normalized;
      return injector.set(core, paramId, Math.max(min, Math.min(max, value)), 1);
    } catch {
      return false;
    }
  };

  // 必须写物理输入参数：这个模型把 ParamAngleX/Y 当作物理「输出」，
  // 直接写会被每帧的物理演算覆盖（表现为调了没反应）。
  // AngleX / AngleY 是安全输入，且会被物理学传导到头发、肩、四肢。
  const okX = writeNormalized('AngleX', px);
  const okY = writeNormalized('AngleY', py);

  if (!okX && !okY) {
    try {
      model.setDragging(px, py);
    } catch {
      /* ignore */
    }
  }
}

/** 播放指定动作组；组或下标不存在时返回 false */
export function playMotion(group: string, index = 0, priority = 2): boolean {
  if (!model) return false;
  markActive();
  try {
    const groups = modelSetting?.FileReferences?.Motions || {};
    const list = groups[group];
    if (!Array.isArray(list) || list.length === 0) return false;
    const no = Math.max(0, Math.min(list.length - 1, Math.floor(Number(index) || 0)));
    model.startMotion(group, no, priority);
    motionDiag = { group: group + '_' + no, startedAt: performance.now(), playing: true };
    motionDirector.commit(group);
    return true;
  } catch {
    return false;
  }
}

export interface PlayMotionOptions {
  index?: number;
  /** 显式打断时用 3；默认 2（Normal），避免动作之间互相硬抢 */
  priority?: number;
  interrupt?: boolean;
  awaitFinish?: boolean;
  /** PR-D：完成事件关联键（=/ai/call 的 callId）。缺省不产出完成事件。 */
  executionId?: string | number;
}

export interface PlayMotionResult {
  status: 'ok' | 'skipped' | 'conflict' | 'failed';
  reason?: string;
  slot?: string;
  dir?: 'open' | 'close';
  group?: string;
  handle?: unknown;
}

/** Loop 动作会在 duration 处回卷；终态使用动作曲线实测终点，而不是运行时取值。 */
function terminalPoseForMotion(group: string): SetPoseInput | null {
  switch (group) {
    case '竖手指打开':
      return { right: 'finger' };
    case '竖手指关闭':
      return { right: 'rest' };
    case '狗尾巴草打开':
      return { right: 'grass' };
    case '狗尾巴草关闭':
      return { right: 'rest' };
    case '抚胸手打开':
      return { left: 'chest' };
    case '抚胸手关闭':
      return { left: 'rest' };
    default:
      return null;
  }
}

/**
 * 结构化动作入口：先过成对状态机与冲突仲裁，再等预加载完成后启动。
 * AI 可以根据返回的 skipped/conflict 原因决定重试或换动作。
 */
export async function playMotionAsync(
  group: string,
  opts: PlayMotionOptions = {}
): Promise<PlayMotionResult> {
  const decision = motionDirector.decide(group);
  if (decision.status === 'skipped' || decision.status === 'conflict') {
    return {
      status: decision.status,
      reason: decision.reason,
      slot: decision.slot,
      dir: decision.dir,
      group: decision.targetGroup,
    };
  }

  if (!model || !model.getModel()) return { status: 'failed', reason: 'not-ready' };

  const target = decision.status === 'ok' ? decision.targetGroup || group : group;
  const groups = modelSetting?.FileReferences?.Motions || {};
  const list = groups[target];
  if (!Array.isArray(list) || list.length === 0) {
    return { status: 'failed', reason: 'unknown-motion-group: ' + target, group: target };
  }
  const no = Math.max(0, Math.min(list.length - 1, Math.floor(Number(opts.index) || 0)));
  const priority = opts.interrupt || opts.priority === 3 ? 3 : opts.priority || 2;

  // S2-ADMIT：冷启动边界 waitForAllMotions 会被个别 404 动作饿死（_motionCount 永不
  // 齐平 → 状态机停在 WaitLoadMotion），目标动作预载缓存缺失时 LAppModel.startMotion
  // 会拿 undefined 同步返回 -1（start-rejected），异步 loadMotion 落位后重试才成功。
  // 这里对目标动作做有界（≤3s）预载等待，把「首击必败」收敛为一次成功调用；
  // 确实不存在的动作等满 3s 后放行，由 startMotion 自行报错（语义不变）。
  {
    const preloadT0 = performance.now();
    while (!model.getMotionDuration(target, no) && performance.now() - preloadT0 < 3000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  markActive();
  const core = model.getModel();
  if (!core) return { status: 'failed', reason: 'not-ready' };

  // 动作独占标志：动作播放期间姿势层完全不写，避免互抢。
  // Loop 动作不会触发结束回调，所以用动作时长定时交还。
  injector.clear(POSE_IDS);
  poseOwnedByMotion = true;
  let finished: Promise<void> | null = null;
  let finishResolve: (() => void) | null = null;
  if (opts.awaitFinish) {
    finished = new Promise<void>((resolve) => {
      finishResolve = resolve;
      pendingFinishResolvers.add(resolve);
    });
  }
  const epoch = motionEpoch;
  const executionId = opts.executionId == null ? '' : String(opts.executionId);
  motionCompletionDone = false;
  motionFinishPending = null;
  const completeMotion = (natural: boolean): void => {
    if (motionStopTimer) {
      window.clearTimeout(motionStopTimer);
      motionStopTimer = 0;
    }
    if (epoch !== motionEpoch) {
      // reset 已发生：收养作废（停动作/姿势收养都归 reset 负责），只放行 awaitFinish 等待者，
      // 否则 playMotionAsync 的 finished promise 会永久挂起。不消耗 motionCompletionDone，
      // 不产完成事件——后续动作的终点归属它自己的 completeMotion。
      if (finishResolve) {
        pendingFinishResolvers.delete(finishResolve);
        finishResolve();
      }
      return;
    }
    if (motionCompletionDone) return; // 自然收敛已收割，看门狗只做幂等空转
    motionCompletionDone = true;
    try {
      model.stopMotions();
    } catch {
      /* ignore */
    }
    poseOwnedByMotion = false;
    const terminal = terminalPoseForMotion(target);
    if (terminal) poseController.adoptPreset(terminal);
    else poseController.adopt(injector.snapshot(core, POSE_IDS));
    if (finishResolve) {
      pendingFinishResolvers.delete(finishResolve);
      finishResolve();
    }
    // PR-D：真实终点只认自然收敛；看门狗/预估路径不发事件（裁决书：不得预估时长）。
    if (natural) {
      emitActionCompletion('motion', executionId, target, injector.getAgentOwned());
    }
  };
  const adoptAfterMotion = (): void => {
    completeMotion(false);
  };
  const motionDuration = model.getMotionDuration(target, no) || 1.25;
  const loopMotion = model.isMotionLoop(target, no);
  if (loopMotion) {
    // Loop 动作会在 duration 处瞬间回到起点；必须在回卷前一点取样收养，
    // 否则读到的是下一圈开头的默认姿势。Loop 无自然终点，不产完成事件（保持预估兜底）。
    motionStopTimer = window.setTimeout(
      adoptAfterMotion,
      Math.max(250, motionDuration * 1000 - 120)
    );
  } else {
    // 非 Loop：真实终点 = onFinishedMotionHandler 自然收敛（motionFinishPending →
    // postLateUpdate 收割）。定时器降级为 fail-closed 看门狗（真实信号丢失才收养），
    // 时长取 duration + 2s——预估不再充当完成信号（裁决书）。
    motionStopTimer = window.setTimeout(
      adoptAfterMotion,
      Math.max(250, motionDuration * 1000 + 2000)
    );
  }
  const onNaturalFinish = (): void => {
    motionFinishPending = () => completeMotion(true);
  };
  const handle = model.startMotion(target, no, priority, onNaturalFinish);
  if (handle === -1) {
    if (motionStopTimer) {
      window.clearTimeout(motionStopTimer);
      motionStopTimer = 0;
    }
    motionFinishPending = null;
    motionCompletionDone = true; // start 失败无终点可言，防御看门狗/事件残留
    poseOwnedByMotion = false;
    if (finishResolve) {
      pendingFinishResolvers.delete(finishResolve);
      finishResolve();
    }
    // PR-A 三态：start 被拒是 failed（非 completed）——同步回执之外的异步消费者
    // （事件订阅链）也必须拿到明确失败，不再静默无事件。
    emitActionCompletion('motion', executionId, target, injector.getAgentOwned(), 'failed', 'start-rejected');
    return { status: 'failed', reason: 'start-rejected', group: target };
  }
  motionDirector.commit(target);
  motionDiag = { group: target + '_' + no, startedAt: performance.now(), playing: true };

  if (finished) await finished;
  return {
    status: 'ok',
    slot: decision.slot,
    dir: decision.dir,
    group: target,
    handle,
  };
}

/** 当前成对动作槽位状态（open/closed），用于诊断与调试面板按钮。 */
export function getMotionSlots(): Record<string, string> {
  return motionDirector.slotStates();
}

/** 设置表情；表情不存在时返回 false */
export function setExpression(name: string): boolean {
  if (!model) return false;
  markActive();
  try {
    const list = modelSetting?.FileReferences?.Expressions || [];
    if (!list.some((e) => e && e.Name === name)) return false;
    model.setExpression(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * 清除表情：脸回到默认（右键菜单「恢复默认脸」用）。
 */
export function clearExpression(): boolean {
  if (!model) return false;
  markActive();
  try {
    model.clearExpression();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 注视与媒体律动
// 眼神/躯体跟随：overlay 只喂归一化目标点（已含死区处理），
// 这里负责平滑并在正确的帧相位写入 —— 眼球在 post 相位（压过动作），
// AngleX/Y 在 pre 相位（作为物理输入，转头会带动头发等次级摆动）。
type CoreModel = NonNullable<ReturnType<LAppModel['getModel']>>;
const gazeState = { target: null as { x: number; y: number } | null, cur: { x: 0, y: 0 } };
// 肢体跟随：比头部更惰性的平滑值（~400ms 时间常数），只在大范围注视时启用（见 applyGazeBody）。
// 只跟主动目标：走神漂移（idleDrift）不摆身体。
const bodyState = { x: 0, y: 0 };
const mediaState = { on: false, phase: 0 };

/** 注视目标：x、y ∈ [-1,1]，相对模型中心；[0,0] 是正对镜头 */
export function gaze(x: number, y: number): void {
  gazeState.target = { x: clamp(Number(x) || 0), y: clamp(Number(y) || 0) };
  markActive();
}

/** 停止注视（眼与头平滑回正） */
export function clearGaze(): void {
  gazeState.target = null;
}

/** 媒体律动开关（音乐播放时随节拍轻摆）；摆动幅度固定轻柔，避免喧宾夺主 */
export function setMediaSway(on: boolean): void {
  mediaState.on = !!on;
  if (!on) {
    mediaState.phase = 0;
    angleBus.AngleZ.media = 0;
  } else {
    stopAmbient();
  }
  syncStageGate();
}

// 自然待机微动作（拟人化）：没有注视目标时，视线每 2.5~4.5s 漂到附近随机点，
// 像人在走神。参考 SoulLink 的平滑过渡与 VTS-AI 的随机微动作思路。
const idleDrift = { nextAt: 1.5, x: 0, y: 0 };

function gazeFrame(dt: number): void {
  if (gazeState.target) {
    // 主动注视：平滑时间常数 ~110ms，眼神要快过头部，但都不能「瞬移」
    const k = 1 - Math.exp(-dt * 9);
    gazeState.cur.x += (gazeState.target.x - gazeState.cur.x) * k;
    gazeState.cur.y += (gazeState.target.y - gazeState.cur.y) * k;
  } else {
    // 待机漂移：换目标点更快（一次性跳变感），但移动慢（走神感）
    idleDrift.nextAt -= dt;
    if (idleDrift.nextAt <= 0) {
      idleDrift.nextAt = 2.5 + Math.random() * 2;
      idleDrift.x = (Math.random() - 0.5) * 0.5;
      idleDrift.y = (Math.random() - 0.5) * 0.3;
    }
    const kd = 1 - Math.exp(-dt * 2.2);
    gazeState.cur.x += (idleDrift.x - gazeState.cur.x) * kd;
    gazeState.cur.y += (idleDrift.y - gazeState.cur.y) * kd;
  }
  // 肢体跟随平滑：身体比头慢半拍（~400ms 时间常数），只跟主动目标（走神漂移不摆身体）
  const bt = gazeState.target || { x: 0, y: 0 };
  const kb = 1 - Math.exp(-dt * 2.5);
  bodyState.x += (bt.x - bodyState.x) * kb;
  bodyState.y += (bt.y - bodyState.y) * kb;
  if (mediaState.on) mediaState.phase += dt * Math.PI * 2 * 1.05;
}

// 参数写入失败计数（HUD 诊断用）：模型缺参数 / 写入抛错时递增，不再静默。
let paramWriteFail = 0;

function writeParam(core: CoreModel, id: string, value: number, add = false): void {
  try {
    const handle = handleOf(id);
    if (!handle) {
      paramWriteFail++;
      return;
    }
    const idx = core.getParameterIndex(handle);
    if (idx < 0) {
      paramWriteFail++;
      return;
    }
    const v = add ? core.getParameterValueById(handle) + value : value;
    core.setParameterValueById(handle, v, 1);
  } catch {
    paramWriteFail++;
  }
}

/**
 * [M1-f 第二批] 每帧 cue 推进：先到期清理（停租约/释放认领/关表情），再经
 * ParamInjector.applyNow 写当前持有值。
 *
 * 为什么必须晚于 applyGazeEyes：gaze 通道写 ParamEyeBallX/Y，先写会被注视收招覆盖。
 * 为什么走 applyNow 而不是 set + apply：sticky 里 AngleZ/LeanInput 等是 add 语义，
 * 二次 apply 会累加；applyNow 复用 set 的全部守卫并按 set 语义单条立即写入。
 */
function applyCueFrame(core: CoreModel): void {
  cueFrameCore = core;
  try {
    cueBridge.tick(performance.now());
  } finally {
    cueFrameCore = null;
  }
}

// 动作自己会写 AngleX 的动作组：动作播放期头让位，避免叠加把头部曲线顶歪。
// 当前模型只有「脱捕」直接写 AngleX（未进 model3 索引，暂时播不到，留作前置防护）。
const HEAD_WRITING_MOTIONS = new Set(['脱捕']);

// 身体量锁存：动作播放期间保持动作开始前的 lean，避免 PositionX/LeanInput 掉回 0 的跳变。
const bodyLatch = { x: 0, y: 0, valid: false };

function motionWritesHead(): boolean {
  const group = String(motionDiag.group || '').split(/[_s]/)[0];
  return HEAD_WRITING_MOTIONS.has(group);
}

function writeGazeBody(core: CoreModel): void {
  // 身体通道走物理上游：本模型 ParamBodyAngleX/Y 是物理输出
  // （大肥鱼.physics3.json：PhysicsSetting4 PositionX→BodyAngleX Scale30；
  //   LeanInput→BodyAngleY Scale35），直写会被物理每帧覆盖。
  // PositionX 进 angleBus 的 gaze 通道，和拖拽/微动作/媒体律动一起限幅，
  // 否则这里的 set 写入会把拖拽位移顶掉。
  angleBus.PositionX.gaze = Math.max(-ANGLE_BUS_CAP.PositionX, Math.min(ANGLE_BUS_CAP.PositionX, bodyLatch.x));
  writeParam(core, 'LeanInput', Math.max(-30, Math.min(30, bodyLatch.y)));
}

function applyGazeBody(core: CoreModel): void {
  const gx = gazeState.cur.x;
  const gy = gazeState.cur.y;
  if (
    !gazeState.target &&
    Math.abs(gx) < 0.005 && Math.abs(gy) < 0.005 &&
    Math.abs(bodyState.x) < 0.005 && Math.abs(bodyState.y) < 0.005
  ) {
    angleBus.PositionX.gaze = 0;
    return;
  }
  const g = Math.sqrt(gx * gx + gy * gy);
  const motionBusy = poseOwnedByMotion || isUserMotionPlaying();
  // 头部：|g|>=0.25 起跟随；20°/g 换算（VTS 设计满量程 ±30，14° 只有一半）。
  if (g >= 0.25 && !(motionBusy && motionWritesHead())) {
    writeParam(core, 'AngleX', gx * 20, true);
    writeParam(core, 'AngleY', gy * 20, true);
  }
  // 身体：0.45 起、0.4 内线性斜坡到满；动作播放期锁存最后值（不归零）。
  const t = Math.max(0, Math.min(1, (g - 0.45) / 0.4));
  if (t > 0.001) {
    if (!motionBusy) {
      bodyLatch.x = bodyState.x * 6 * t;
      bodyLatch.y = bodyState.y * 4 * t;
      bodyLatch.valid = true;
    }
    writeGazeBody(core);
    return;
  }
  // 动作期即使 gaze 回到中心也保持锁存，等动作结束再回落
  if (motionBusy && bodyLatch.valid) {
    writeGazeBody(core);
    return;
  }
  if (bodyLatch.valid) {
    bodyLatch.x *= 0.72;
    bodyLatch.y *= 0.72;
    if (Math.abs(bodyLatch.x) < 0.01 && Math.abs(bodyLatch.y) < 0.01) {
      bodyLatch.x = 0;
      bodyLatch.y = 0;
      bodyLatch.valid = false;
    }
    writeGazeBody(core);
    return;
  }
  angleBus.PositionX.gaze = 0;
  writeParam(core, 'LeanInput', 0);
}

function applyGazeEyes(core: CoreModel): void {
  if (!gazeState.target && Math.abs(gazeState.cur.x) < 0.005 && Math.abs(gazeState.cur.y) < 0.005) return;
  writeParam(core, 'ParamEyeBallX', gazeState.cur.x);
  writeParam(core, 'ParamEyeBallY', gazeState.cur.y);
}

// ---------------------------------------------------------------- FI 帧写入（PR-01）
const clampUnit = (v: number): number => Math.max(0, Math.min(1, v));
const clampBipolar = (v: number): number => Math.max(-1, Math.min(1, v));

/** pre 相位：头角写入（AngleX/Y/Z 是 ADDITIVE_INPUTS，必须显式 mode:'set' 否则逐帧累加）。 */
function applyFacialHead(core: CoreModel): void {
  const f = facialFrameCache;
  if (!f) return;
  const motionBusy = poseOwnedByMotion || isUserMotionPlaying();
  const manualHead = facialBridge.manualActives().some((s) => s.startsWith('head.'));
  if (motionBusy && !manualHead) return; // 动作播放期头让位（与 gaze 的 motionWritesHead 约定一致）
  let written = 0;
  let rejected = 0;
  if (f.headX !== undefined) { if (injector.set(core, 'AngleX', f.headX, 1, { mode: 'set' })) written++; else rejected++; }
  if (f.headY !== undefined) { if (injector.set(core, 'AngleY', f.headY, 1, { mode: 'set' })) written++; else rejected++; }
  if (f.headZ !== undefined) { if (injector.set(core, 'AngleZ', f.headZ, 1, { mode: 'set' })) written++; else rejected++; }
  facialBridge.recordWriteResult(written, rejected, performance.now());
}

/** post 相位（cue 之后最后写者）：tick 产帧 + 眼部写入；头角留给下一帧 pre。 */
function applyFacialEyes(core: CoreModel, dtSeconds: number): void {
  const f = facialBridge.tick(performance.now(), Math.max(0, dtSeconds * 1000));
  facialFrameCache = f;
  let written = 0;
  let rejected = 0;
  if (f.eyeL !== undefined) { if (injector.set(core, 'ParamEyeLOpen', clampUnit(f.eyeL), 1, { mode: 'set' })) written++; else rejected++; }
  if (f.eyeR !== undefined) { if (injector.set(core, 'ParamEyeROpen', clampUnit(f.eyeR), 1, { mode: 'set' })) written++; else rejected++; }
  if (f.eyeGX !== undefined) { if (injector.set(core, 'ParamEyeBallX', clampBipolar(f.eyeGX), 1, { mode: 'set' })) written++; else rejected++; }
  if (f.eyeGY !== undefined) { if (injector.set(core, 'ParamEyeBallY', clampBipolar(f.eyeGY), 1, { mode: 'set' })) written++; else rejected++; }
  facialBridge.recordWriteResult(written, rejected, performance.now());
}

/**
 * LLM FacialPlan 入口：Schema 验证（validateFacialPlan）→ 仲裁登记 → 平滑执行。
 * 验证失败拒绝并回 errors，不写入任何参数。
 */
export function applyFacialIntent(json: unknown): { ok: boolean; errors: string[]; warnings?: string[] } {
  if (!FI_ENABLED) return { ok: false, errors: ['facial-intelligence disabled'] };
  return facialBridge.applyPlan(json, performance.now());
}

/** 手动覆盖（Parameter Inspector 拖动）：MANUAL=900，不被 LLM 盖；release 释放后平滑恢复 */
export function setManualFacialParam(semantic: string, value: number): boolean {
  if (!FI_ENABLED) return false;
  if (!(FI_SEMANTICS as readonly string[]).includes(semantic)) return false;
  return facialBridge.setManual(semantic as FacialSemantic, value);
}

export function releaseManualFacial(): void {
  facialBridge.releaseManual();
}

/** 表情预览（Control Studio 测试按钮）：走同一 FI 链路，不新建 Cubism 控制路径 */
export function previewFacialEmotion(emotion: string, intensity = 0.6): boolean {
  if (!FI_ENABLED) return false;
  facialBridge.setEmotion(emotion, intensity, performance.now());
  return true;
}

export function getFacialState(): Record<string, unknown> {
  return {
    enabled: FI_ENABLED,
    authority: facialBridge.hasAuthority(),
    manual: facialBridge.manualActives(),
    diag: facialBridge.getDiag(),
  };
}

// ---------------------------------------------------------------- 命中判定（alpha 采样）
// overlay 把光标位置设为探针（setHitProbe），本包在每帧渲染完的同一任务里
// readPixels 1×1 缓存 alpha——默认 drawingBuffer 会在合成后被清，事件回调里临时读恒为 0，
// 必须紧跟渲染。点击时 overlay 用 hitTestAt 判定：真点在模型像素上才拦事件，
// 空白处放行，鼠标直接透过到下层页面。
// 注意：探针（输入坐标）与采样点（实际读像素的坐标）分开记录。pointerdown 会先把探针
// 更新成点击点，若用探针坐标比较，就会拿旧位置的 alpha 判新点——快速移动后点按必误判。
const hitProbe = {
  x: 0,
  y: 0,
  on: false,
  alpha: 0,
  sampledX: 0,
  sampledY: 0,
  hasSample: false,
  /** pointerdown 强制下一帧采样（点击判定要新鲜）；hover 走 100ms 节流 */
  force: false,
  lastAt: 0,
  buf: null as Uint8Array | null,
};

/** 设置命中探针（客户端坐标）；采样节流/强制见 maybeSampleHitProbe */
export function setHitProbe(clientX: number, clientY: number): void {
  hitProbe.x = clientX;
  hitProbe.y = clientY;
  hitProbe.on = true;
}

/** 请求下一帧强制采样一次（点击/拖拽起手时用，保证判定用的是点击点附近的 alpha） */
export function requestHitSample(): void {
  hitProbe.force = true;
}

/**
 * 命中采样调度（必须紧跟本帧渲染，否则 drawingBuffer 内容未定义）。
 * hover 最多 10Hz；pointerdown 强制一次；窗口失焦/隐藏时完全跳过——
 * readPixels 是同步 GPU→CPU 往返，之前每帧 60 次是全场景卡顿的主因。
 */
function maybeSampleHitProbe(now: number): void {
  if (!hitProbe.on) return;
  if (!hitProbe.force && now - hitProbe.lastAt < 100) return;
  if (!windowFocused || pausedByVisibility) return;
  hitProbe.force = false;
  hitProbe.lastAt = now;
  sampleHitProbe();
}

/**
 * 该客户端坐标是否落在模型不透明像素上。
 * 采样点与判定点相差 ≤16px 才用缓存的 alpha；差太多（快速移动后立刻点按）
 * 判定不可靠，按「未命中」放行——穿透优先：宁可让页面收到这次点击，
 * 也不吞掉对下层界面的操作。采样还没就绪时保守放行互动（兼容旧调用方）。
 */
export function hitTestAt(clientX: number, clientY: number): boolean {
  if (!hitProbe.on || !hitProbe.hasSample) return true;
  if (Math.abs(hitProbe.sampledX - clientX) > 16 || Math.abs(hitProbe.sampledY - clientY) > 16) return false;
  return hitProbe.alpha > 22 / 255;
}

/**
 * 同步包围盒命中：右键菜单专用，不依赖上一帧 alpha 采样。
 * contextmenu 与 pointerdown 在同一事件循环里，alpha 采样根本来不及更新；
 * 用 fitModel 的模型矩阵把可见包围盒投影到画布像素，再映射回客户端坐标。
 * 比 alpha 采样粗（包含包围盒内的透明区），但同步、稳定，不会全屏误判。
 */
export function hitTestBox(clientX: number, clientY: number): boolean {
  if (!canvasEl || !fitState) return false;
  try {
    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width || !rect.height || !canvasEl.width || !canvasEl.height) return false;
    const W = canvasEl.width;
    const H = canvasEl.height;
    const b = fitState;
    const ndcX0 = b.sx * b.x0 + b.tx;
    const ndcX1 = b.sx * (b.x0 + b.w) + b.tx;
    const ndcY0 = b.sy * b.y0 + b.ty;
    const ndcY1 = b.sy * (b.y0 + b.h) + b.ty;
    const px0 = ((Math.min(ndcX0, ndcX1) + 1) / 2) * W;
    const px1 = ((Math.max(ndcX0, ndcX1) + 1) / 2) * W;
    // GL 像素坐标原点在左下；clientY 原点在左上，用 rect.bottom 翻转
    const py0 = ((Math.min(ndcY0, ndcY1) + 1) / 2) * H;
    const py1 = ((Math.max(ndcY0, ndcY1) + 1) / 2) * H;
    const cx = ((clientX - rect.left) / rect.width) * W;
    const cy = ((rect.bottom - clientY) / rect.height) * H;
    return cx >= px0 && cx <= px1 && cy >= py0 && cy <= py1;
  } catch {
    return false;
  }
}

function sampleHitProbe(): void {
  if (!hitProbe.on || !sub || !canvasEl) return;
  try {
    const gl = sub.getGl();
    if (!gl) return;
    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = Math.round(((hitProbe.x - rect.left) / rect.width) * canvasEl.width);
    const py = Math.round(((rect.bottom - hitProbe.y) / rect.height) * canvasEl.height);
    if (px < 0 || px >= canvasEl.width || py < 0 || py >= canvasEl.height) {
      hitProbe.alpha = 0;
      hitProbe.sampledX = hitProbe.x;
      hitProbe.sampledY = hitProbe.y;
      hitProbe.hasSample = true;
      return;
    }
    const buf = hitProbe.buf || (hitProbe.buf = new Uint8Array(4));
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    hitProbe.alpha = buf[3] / 255;
    hitProbe.sampledX = hitProbe.x;
    hitProbe.sampledY = hitProbe.y;
    hitProbe.hasSample = true;
  } catch {
    /* 采样失败保留上次值 */
  }
}

function applyMediaLayer(): void {
  // 媒体律动只贡献 AngleZ。关掉传感器时这一路必须是 0，不能留在注入器里。
  angleBus.AngleZ.media = mediaState.on ? Math.sin(mediaState.phase) * 5.5 : 0;
}

/** 仅改缩放，不动画布尺寸（拖拽面部微放大用；layout 会重设画布，太重） */
export function setZoom(zoom: number): void {
  if (!sub || !canvasEl) return;
  currentZoom = Math.max(0.5, Math.min(2, Number(zoom) || 1));
  fitModel(canvasEl.width, canvasEl.height, currentZoom);
}

/** 清除所有外部姿势/关键帧，交还模型自身的动作与物理。 */
export function resetPose(): number {
  const core = model?.getModel();
  if (!core) return 0;
  if (TIMELINE_ENABLED) gestureBridge.stop(); // [M1-d2] 清空手势时间线与 armed，与 stopKeyframes 同步清账
  if (CUE_ENABLED) cueBridge.stop(); // [M1-f 第二批] 清 cue 账本（channel/overlay），停在手写值
  stopKeyframes();
  stopAmbient();
  zeroAngleBus();
  injector.releaseAll();
  injector.clear();
  injector.unlock();
  poseController.resetToRest();
  markActive();
  return core.getParameterCount();
}

/**
 * 收尾：姿势、表情、注视一起回到待机。邪神退出和 l2d_reset 用这一条。
 *
 * 真机缺陷修复（choreo 复现：真机 l2d_reset 后「竖手指:open」残留可见）。
 * 根因：旧 reset 只清姿势/表情/注视层，没停正在播的动作 —— 竖手指打开是 Loop 动作，
 * 每帧持续写手臂参数（Param36/39/40/41/42/43），把 poseController 刚复位的手臂又压回去；
 * motionDirector 的 slot 状态也没归位，调试面板与后续仲裁仍认为 open。
 * 真机复现步骤：真机播 竖手指打开（不播关闭），直接 l2d_reset ——
 * 修复前手臂保持抬起、info.motion slots=竖手指:open；修复后手臂回落、slots=竖手指:closed。
 */
export function resetPerformance(): { ok: boolean; params: number } {
  if (emotionCloseTimer) {
    window.clearTimeout(emotionCloseTimer);
    emotionCloseTimer = 0;
  }
  // 停掉 playing motion 并把 slot 状态归位（参考 closeMotionsOnPreempt 的清理语义：
  // 手臂不再被动作占用）；递增纪元让未触发的收招定时器作废，防止终态姿势在 reset 后复活
  motionEpoch++;
  if (motionStopTimer) {
    window.clearTimeout(motionStopTimer);
    motionStopTimer = 0;
  }
  motionFinishPending = null;
  motionCompletionDone = true;
  // 泄漏修复：reset 清掉了 completeMotion 的全部触发路径（定时器已清、待处理已空、
  // 纪元已递增），登记中的 awaitFinish 等待者若不放行，其 finished promise 永久挂起。
  for (const settle of pendingFinishResolvers) settle();
  pendingFinishResolvers.clear();
  try {
    model?.stopMotions();
  } catch {
    /* ignore */
  }
  poseOwnedByMotion = false;
  motionDirector.reset();
  facialBridge.reset(); // FI 状态归零：意图/手动/微表情全清，控制器平滑回默认
  motionDiag = { group: 'none', startedAt: 0, playing: false };
  const params = resetPose();
  clearExpression();
  clearGaze();
  return { ok: true, params };
}

export interface SetPoseInput {
  right?: 'rest' | 'finger' | 'grass' | 'chest';
  left?: 'rest' | 'finger' | 'grass' | 'chest';
}

export interface SetPoseResult {
  ok: boolean;
  reason?: string;
  pose?: { right: string; left: string; active: boolean };
}

/**
 * 四肢姿势入口：枚举值，不暴露裸参数，避免 AI 把手臂拧畸形。
 * 动作播放期间拒绝，避免和动作互抢同一批手臂参数。
 */
export function setPose(req: SetPoseInput): SetPoseResult {
  const core = model?.getModel();
  if (!core) return { ok: false, reason: 'not-ready' };
  if (isUserMotionPlaying()) return { ok: false, reason: 'motion-playing' };

  const right = req?.right;
  const left = req?.left;
  const allowed = ['rest', 'finger', 'grass', 'chest'];
  if ((right && allowed.indexOf(right) < 0) || (left && allowed.indexOf(left) < 0)) {
    return { ok: false, reason: 'invalid-pose' };
  }
  poseController.setPose({ right, left });
  markActive();
  return { ok: true, pose: poseController.describe() };
}

export function getPose(): { right: string; left: string; active: boolean } {
  return poseController.describe();
}

function isUserMotionPlaying(): boolean {
  try {
    const mm = (model as unknown as {
      _motionManager?: {
        isFinished?: () => boolean;
        getCurrentPriority?: () => number;
      };
    })?._motionManager;
    if (!mm?.isFinished) return false;
    return !mm.isFinished() && (mm.getCurrentPriority ? mm.getCurrentPriority() >= 2 : false);
  } catch {
    return false;
  }
}

/** 调试/校准用：读取当前参数值（不对外给 AI，避免误当姿势入口） */
export function readParameters(ids: string[]): Record<string, number> {
  const core = model?.getModel();
  if (!core || !Array.isArray(ids)) return {};
  return injector.snapshot(core, ids);
}

export interface ParamMeta {
  id: string;
  min: number;
  max: number;
  def: number;
  /** Node Ownership：是否在托管白名单内（仅表示可托管，读≠控制权） */
  hostable?: boolean;
}

export interface Capabilities {
  model: string;
  expressions: string[];
  motionGroups: string[];
  params: ParamMeta[];
}

/**
 * 运行时自省：返回这个模型真正支持的表情、动作组和参数范围。
 * 给 AI 用的工具清单应该基于它生成，而不是写死 —— 换模型后自动适配。
 */
export function getCapabilities(): Capabilities | null {
  if (!model) return null;
  const core = model.getModel();
  if (!core) return null;

  const expressions = (modelSetting?.FileReferences?.Expressions || [])
    .map((e) => (e && e.Name ? e.Name : ''))
    .filter((s) => !!s);

  const motionGroups = Object.keys(modelSetting?.FileReferences?.Motions || {});

  const params: ParamMeta[] = [];
  try {
    const count = core.getParameterCount();
    for (let i = 0; i < count; i++) {
      const id = core.getParameterId(i);
      params.push({
        id: id.getString(),
        min: +core.getParameterMinimumValue(i).toFixed(3),
        max: +core.getParameterMaximumValue(i).toFixed(3),
        def: +core.getParameterDefaultValue(i).toFixed(3),
        hostable: isHostable(id.getString()),
      });
    }
  } catch {
    /* ignore */
  }

  return {
    model: modelSetting?.FileReferences?.Moc || '',
    expressions,
    motionGroups,
    params,
  };
}

export async function destroy(): Promise<void> {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (driverTimer) {
    clearInterval(driverTimer);
    driverTimer = 0;
  }
  lastTickAt = 0;
  nextTickAt = 0;
  gateFps = 0;
  lastRafAt = 0;
  try {
    model?.setPreLateUpdateHook(null);
    model?.setPostLateUpdateHook(null);
  } catch {
    /* ignore */
  }
  injector.clear();
  injector.unlock();
  injector.resetStats();
  physicsGate.dispose(); // [M1-b] 清掉让位登记表，避免残留状态影响下一次 mount（physicsGate 为模块级 const，实例必存在）
  if (TIMELINE_ENABLED) gestureBridge.stop(); // [M1-d2] 清手势时间线与 armed
  if (CUE_ENABLED) cueBridge.stop(); // [M1-f 第二批] 清 cue 账本（destroy 后不残留持有值）
  motionDirector.reset();
  poseOwnedByMotion = false;
  poseController.resetToRest();
  kfActive = false;
  kfTracks = [];
  try {
    model?.release?.();
  } catch {
    /* ignore */
  }
  model = null;
  modelLabel = '';
  try {
    sub?.release();
  } catch {
    /* ignore */
  }
  sub = null;
  canvasEl = null;
  frames = 0;
  lastError = '';
}

export function isReady(): boolean {
  return !!model && !!model.getModel();
}

export function getInfo(): Record<string, number | string> | null {
  if (!model) return null;
  const core = model.getModel();
  if (!core) return null;

  // GL 层状态：贴图尺寸上限、错误码、实际像素缓冲
  let glErr = 'n/a';
  let maxTex = 0;
  try {
    const gl = sub?.getGl();
    if (gl) {
      maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      glErr = String(gl.getError());
    }
  } catch {
    glErr = 'query-failed';
  }

  // 参数级诊断：Cubism 5 的 getParameterValueById 需要 CubismIdHandle，传字符串会抛错
  let params = 'n/a';
  let utime = -1;
  try {
    const anyM = model as unknown as { _userTimeSeconds?: number };
    utime = anyM._userTimeSeconds ?? -1;

    const idMgr = CubismFramework.getIdManager();
    const ids = [
      'AngleX',
      'AngleY',
      'AngleZ',
      'PositionX',
      'LeanInput',
      'ParamAngleX',
      'ParamBodyAngleX',
      'ParamBodyAngleY',
      'ParamBodyAngleZ',
      // 四肢所有权验证用：物理输出被 Agent 独占后应保持写入值
      'RArm',
      'LArm',
      'ShoulderX',
      'SideHairRX1',
      'ParamBreath',
      'ParamEyeLOpen',
    ];
    const parts: string[] = [];
    for (const name of ids) {
      try {
        const handle = idMgr.getId(name);
        parts.push(name + '=' + core.getParameterValueById(handle).toFixed(3));
      } catch {
        parts.push(name + '=?');
      }
    }
    // 判定是否真的在动：与上次采样比较
    try {
      const h = idMgr.getId('AngleX');
      const now = core.getParameterValueById(h);
      if (lastParamSample !== null) {
        parts.push('chg=' + (Math.abs(now - lastParamSample) > 1e-5 ? 'yes' : 'no'));
      }
      lastParamSample = now;
    } catch {
      /* ignore */
    }
    try {
      const mm = (model as unknown as { _motionManager?: { isFinished?: () => boolean } })
        ._motionManager;
      parts.push('finished=' + (mm && mm.isFinished ? String(mm.isFinished()) : '?'));
    } catch {
      parts.push('finished=?');
    }
    params = parts.join(' ');
  } catch {
    params = 'err';
  }

  let mxNow = 'n/a';
  try {
    const a = model.getModelMatrix().getArray();
    mxNow = [a[0], a[5], a[12], a[13]].map((v) => v.toFixed(3)).join(',');
  } catch {
    mxNow = 'err';
  }

  // 真机缺陷修复（choreo 复现：真机 get_state 的 info.motion playing=1，与
  // isUserMotionPlaying()（下称 il()）=0 结论矛盾）。
  // 根因：旧实现 playing = !isFinished()，而 Idle 动作是 Loop 永不 finished，
  // playing 恒为 1 —— 它只反映「有动作在播（含待机）」，不反映「用户请求的动作还在播」，
  // 验收脚本据此判断动作状态必误读。另 motionDiag.playing 只在 getInfo 被轮询时刷新，
  // 两次轮询之间是陈旧值，故不再作为数据源。
  // 现以 MotionManager 真实状态为准：
  //   playing = !isFinished() && currentPriority >= 2（用户级动作，与 isUserMotionPlaying 同源）
  //   idle    = !isFinished()（原始信号，含待机 Loop，仅供人工对照）
  // 真机复现步骤：真机空闲时调 l2d_get_state —— 修复前 playing=1（实为待机 Loop）；
  // 修复后 playing=0 idle=1；播 竖手指打开 期间 playing=1，播完回 0。
  let motionPlaying = false;
  let motionIdle = false;
  try {
    const mm = (model as unknown as {
      _motionManager?: {
        isFinished?: () => boolean;
        getCurrentPriority?: () => number;
      };
    })._motionManager;
    if (mm?.isFinished) {
      motionIdle = !mm.isFinished();
      motionPlaying = motionIdle && (mm.getCurrentPriority ? mm.getCurrentPriority() >= 2 : false);
    }
  } catch {
    /* MotionManager 读不到时按「没有用户动作在播」处理 */
  }
  motionDiag.playing = motionPlaying;
  // group/startedAt 只在「开始动作」时写入。动作播完后 Idle 会无限续播，
  // 若只按 isFinished 判定，诊断会一直显示上一个动作名、t 也越滚越大，误导排查。
  // 这里按「用户动作是否真的还在播」归零：没在播就清计时，让 t 从 0 重新计。
  if (!motionPlaying) {
    motionDiag.startedAt = 0;
  }
  const motionElapsed = motionDiag.startedAt
    ? ((performance.now() - motionDiag.startedAt) / 1000).toFixed(2)
    : '0.00';

  const inj = injector.diagnostics();
  const slotText = Object.entries(motionDirector.slotStates())
    .map(([slot, state]) => slot + ':' + state)
    .join(',');
  return {
    frames,
    fpsCap: targetFps,
    // 实测刷新率（rAF 间隔倒数）。采集器据此判断「49fps 是不是高刷屏限帧量化」。
    vsyncHz: +((1000 / (vsyncMs || 16.7)).toFixed(1)),
    mxNow,
    phase: 'pre=' + phaseDiag.pre + ' post=' + phaseDiag.post,
    inj:
      'calls=' +
      inj.calls +
      ' writes=' +
      inj.writes +
      ' skip=' +
      inj.skipped +
      ' sticky=' +
      inj.sticky +
      ' locked=' +
      inj.locked +
      ' owned=' +
      inj.owned +
      ' modes=' +
      inj.modes.set +
      '/' +
      inj.modes.add +
      ' pw=' +
      inj.phaseWrites.pre +
      '/' +
      inj.phaseWrites.post +
      ' seen=' +
      inj.applySeen.pre +
      '/' +
      inj.applySeen.post +
      ' ne=' +
      inj.applySeen.preNonEmpty +
      '/' +
      inj.applySeen.postNonEmpty +
      ' dbg=' +
      inj.debug.modeMismatch +
      ':' +
      inj.debug.lastPhase +
      ':' +
      inj.debug.lastMode +
      ':' +
      inj.debug.firstId,
    motion:
      'group=' +
      motionDiag.group +
      ' playing=' +
      (motionPlaying ? 1 : 0) +
      ' idle=' +
      (motionIdle ? 1 : 0) +
      ' t=' +
      motionElapsed +
      ' slots=' +
      (slotText || 'none'),
    emotion: emotionRouter.diagnostics(),
    lastError: lastError || 'none',
    shader: shaderDiag,
    fit: fitDiag,
    utime: +utime.toFixed(2),
    pv: params,
    dt: +LAppPal.getDeltaTime().toFixed(4),
    canvasW: +core.getCanvasWidth().toFixed(4),
    canvasH: +core.getCanvasHeight().toFixed(4),
    drawables: core.getDrawableCount ? core.getDrawableCount() : 0,
    params: core.getParameterCount ? core.getParameterCount() : 0,
    zoom: currentZoom,
    pxW: canvasEl ? canvasEl.width : 0,
    pxH: canvasEl ? canvasEl.height : 0,
    dpr: typeof window !== 'undefined' ? Math.round((window.devicePixelRatio || 1) * 100) / 100 : 1,
    // overlay 的鼠标诊断计数器：moves 增长说明 DSH 页面确实把 pointermove 送到了 overlay；
    // g 是归一化后的注视幅度（|g|>=0.25 转头、>=0.6 带身体）。
    mouse: (() => {
      try {
        const probe = (
          window as unknown as {
            __DSH_L2D_MOUSE__?: {
              moves?: number;
              at?: number;
              gx?: number;
              gy?: number;
              rawX?: number;
              rawY?: number;
              winW?: number;
              winH?: number;
              cx?: number;
              cy?: number;
              rectW?: number;
              rectH?: number;
              rectX?: number;
              rectY?: number;
            };
          }
        ).__DSH_L2D_MOUSE__;
        if (!probe) return 'none';
        const age = probe.at ? Math.round((Date.now() - probe.at) / 100) / 10 : -1;
        return (
          'moves=' + (probe.moves || 0) +
          ' age=' + age + 's g=' + (probe.gx || 0) + ',' + (probe.gy || 0) +
          ' at=' + (probe.rawX == null ? '?' : probe.rawX) + ',' + (probe.rawY == null ? '?' : probe.rawY) +
          ' win=' + (probe.winW == null ? '?' : probe.winW) + 'x' + (probe.winH == null ? '?' : probe.winH) +
          ' ctr=' + (probe.cx == null ? '?' : probe.cx) + ',' + (probe.cy == null ? '?' : probe.cy) +
          ' rect=' + (probe.rectW == null ? '?' : probe.rectW) + 'x' + (probe.rectH == null ? '?' : probe.rectH) +
          '@' + (probe.rectX == null ? '?' : probe.rectX) + ',' + (probe.rectY == null ? '?' : probe.rectY)
        );
      } catch {
        return 'err';
      }
    })(),
    // 注视参数可用性诊断：缺哪个一眼可见（✗ 前缀）；fail 是 writeParam 累计失败次数，
    // >0 说明有参数写不进去（模型缺参数/写入异常），不再被静默吞掉。
    gaze: (() => {
      try {
        const want = ['ParamEyeBallX', 'ParamEyeBallY', 'AngleX', 'AngleY', 'PositionX', 'LeanInput'];
        const out: string[] = [];
        for (const id of want) {
          const handle = handleOf(id);
          const ok = !!(handle && core.getParameterIndex(handle) >= 0);
          out.push((ok ? '' : '✗') + id);
        }
        return out.join(' ') + ' fail=' + paramWriteFail;
      } catch {
        return 'err';
      }
    })(),
    maxTex,
    glErr,
  };
}

/**
 * 动作链执行计划（并行组 / 整组超时 / 冲突降级）。
 *
 * 必须是**具名导出**：打包成 UMD 后，页面上的 window.DSH_L2D 拿到的是模块命名空间，
 * 只挂在 default 的 api 对象上的方法读不到——并行组/整组超时因此在浏览器里从未生效过
 * （node 测试直接 import 源码，所以一直是绿的）。
 */
export const normalizeActPlan = (chain: Parameters<typeof normalizeActChain>[0]) =>
  normalizeActChain(chain);

// E2：语义姿态执行计划（纯函数；profile 由 overlay 预取后传入，渲染层不读文件）
export { planPostureExecution } from '../../core/src/posture.ts';

const api = {
  loadCore,
  mount,
  layout,
  // 动作链执行计划（并行组 / 整组超时 / 冲突降级）：纯函数，overlay 按桶投放
  normalizeActPlan,
  // 控制
  setParameter,
  setParameters,
  setParametersRuntime,
  ownParameters,
  releaseParameters,
  getOwnedParameters,
  lookAt,
  playMotion,
  playMotionAsync,
  getMotionSlots,
  setPose,
  getPose,
  readParameters,
  setExpression,
  resetPose,
  playKeyframes,
  stopKeyframes,
  getKeyframeOwnedParameters,
  markActive,
  setPreUpdate,
  emotionSignal,
  setEmotionBubble,
  clearExpression,
  gaze,
  clearGaze,
  setHitProbe,
  hitTestAt,
  requestHitSample,
  hitTestBox,
  setMediaSway,
  setStageBusy,
  resetPerformance,
  applyFacialIntent,
  setManualFacialParam,
  releaseManualFacial,
  previewFacialEmotion,
  getFacialState,
  setZoom,
  getEmotionState,
  injectEmotionIntent,
  admitAct,
  finishAct,
  releaseAct,
  currentAct,
  actPhaseTemplate,
  closeMotionsOnPreempt,
  preemptedYandere,
  motionsShareArm,
  motionResultKind,
  noteActMotion,
  // [M1-d2] 手势时间线动作面（embodied.timeline flag，默认关）
  admitGesture,
  stopGesture,
  getGestureState,
  // [M1-f 第二批] EmbodiedCue 行为闭环（embodied.cue flag，默认关）
  admitCue,
  stopCue,
  getCueState,
  getCapabilities,
  // 生命周期
  destroy,
  isReady,
  getInfo,
  // 模型名自省：getter 形式避免 api 字面量创建时把 '' 快照冻结；与具名导出同源 modelLabel。
  get modelName() {
    return modelLabel;
  },
  get model() {
    return modelLabel;
  },
};
export default api;

(window as unknown as { DSH_L2D?: typeof api }).DSH_L2D = api;
