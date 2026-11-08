<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import M3Segmented from './M3Segmented.vue';
import type { SegmentOption } from './M3Segmented.vue';
import M3Slider from './M3Slider.vue';
import M3Switch from './M3Switch.vue';
import M3Button from './M3Button.vue';
import M3Icon from './M3Icon.vue';
import DshTextInput from './DshTextInput.vue';
import DshSelect from './DshSelect.vue';
import type { SelectOption } from './DshSelect.vue';
import { resetSettings, useSettings } from '../composables/useSettings.ts';
import type { ContextState, ThemeMode } from '../composables/useSettings.ts';

const { settings } = useSettings();

const themeOptions: SegmentOption[] = [
  { value: 'dark', label: '深色', icon: 'moon' },
  { value: 'light', label: '浅色', icon: 'sun' },
];

const contextOptions: SegmentOption[] = [
  { value: 'idle', label: '待机' },
  { value: 'conversation', label: '问答' },
  { value: 'work', label: '操作' },
  { value: 'away', label: '离席' },
];

const themeModel = computed<string>({
  get: () => settings.theme,
  set: (v) => (settings.theme = v as ThemeMode),
});

const contextModel = computed<string>({
  get: () => settings.contextPreview,
  set: (v) => (settings.contextPreview = v as ContextState),
});

const pct = (v: number) => `${Math.round(v * 100)}%`;

// ---- 运行时（自 settings.html sec-model 吸收，读真实 status.json，取不到显示「—」）----
interface RuntimeStatus {
  model: string | null;
  renderer: boolean;
  core: boolean;
  avatarFound: boolean;
}
const runtime = ref<Partial<RuntimeStatus> | null>(null);
const runtimeError = ref(false);
let runtimeTimer = 0;

async function pollRuntime() {
  try {
    const res = await fetch('/dsh-l2d/status.json', { cache: 'no-store' });
    runtime.value = res.ok ? ((await res.json()) as RuntimeStatus) : null;
    runtimeError.value = !res.ok;
  } catch {
    runtime.value = null;
    runtimeError.value = true;
  }
}

pollRuntime();
runtimeTimer = window.setInterval(pollRuntime, 15000);
onBeforeUnmount(() => window.clearInterval(runtimeTimer));

const yesNo = (v: boolean | undefined) => (v === undefined ? '—' : v ? '已就位' : '缺失');

// ---- 连接（界面先行：持久化到本地，运行时写入通道 TODO，未接通前不宣称生效）----
const transportOptions: SelectOption[] = [
  { value: 'plugin', label: 'DSH 插件通道（/dsh-l2d/）' },
  { value: 'dev', label: '调试服通道（dev-server）' },
];
const CONNECT_KEY = 'dsh-l2d.stage.connect.v1';
const connect = ref<{ endpoint: string; transport: string }>({ endpoint: '/dsh-l2d/', transport: 'plugin' });
try {
  const saved = JSON.parse(localStorage.getItem(CONNECT_KEY) || '{}');
  if (typeof saved.endpoint === 'string') connect.value.endpoint = saved.endpoint;
  if (typeof saved.transport === 'string') connect.value.transport = saved.transport;
} catch { /* 隐私模式忽略 */ }
function persistConnect() {
  try {
    localStorage.setItem(CONNECT_KEY, JSON.stringify(connect.value));
  } catch { /* ignore */ }
}
</script>

<template>
  <div class="settings">
    <section class="group">
      <h3>外观</h3>

      <div class="row col">
        <div class="text">
          <span class="k">主题</span>
          <span class="d">跟随所选主题</span>
        </div>
        <M3Segmented v-model="themeModel" :options="themeOptions" full />
      </div>

      <div class="row col">
        <div class="text">
          <span class="k">模型缩放</span>
          <span class="d">舞台内角色的显示比例</span>
        </div>
        <M3Slider v-model="settings.scale" :min="0.6" :max="1.6" :step="0.05" :suffix="pct(settings.scale)" />
      </div>
    </section>

    <section class="group">
      <h3>行为</h3>

      <div class="row col">
        <div class="text">
          <span class="k">待机活跃度</span>
          <span class="d">呼吸、眨眼、视线漂移的幅度</span>
        </div>
        <M3Slider
          v-model="settings.idleIntensity"
          :min="0"
          :max="1"
          :step="0.05"
          :suffix="pct(settings.idleIntensity)"
        />
      </div>

      <div class="row">
        <div class="text">
          <span class="k">操作时反应</span>
          <span class="d">打字节奏、窗口切换时轻微回应</span>
        </div>
        <M3Switch v-model="settings.typingReaction" label="操作时反应" />
      </div>

      <div class="row">
        <div class="text">
          <span class="k">全屏时自动降级</span>
          <span class="d">检测到全屏应用降到 15fps，避免打扰</span>
        </div>
        <M3Switch v-model="settings.fullscreenDegrade" label="全屏时自动降级" />
      </div>

      <div class="row col">
        <div class="text">
          <span class="k">情境预览</span>
          <span class="d">仅用于预览行为差异，不影响真实感知</span>
        </div>
        <M3Segmented v-model="contextModel" :options="contextOptions" full />
      </div>
    </section>

    <section class="group">
      <h3>语音</h3>

      <div class="row">
        <div class="text">
          <span class="k">口型同步</span>
          <span class="d">按音频包络驱动嘴部开合</span>
        </div>
        <M3Switch v-model="settings.lipSync" label="口型同步" />
      </div>

      <div class="row col">
        <div class="text">
          <span class="k">口型增益</span>
          <span class="d">音量偏小时可上调，过高会「嘴抽」</span>
        </div>
        <M3Slider
          v-model="settings.lipSyncGain"
          :min="0.5"
          :max="2"
          :step="0.1"
          :suffix="`${settings.lipSyncGain.toFixed(1)}×`"
          :disabled="!settings.lipSync"
        />
      </div>
    </section>

    <section class="group">
      <h3>感知与隐私</h3>

      <div class="row">
        <div class="text">
          <span class="k">摄像头面部捕捉</span>
          <span class="d">MediaPipe 本地推理，画面不出本机</span>
        </div>
        <M3Switch v-model="settings.cameraTracking" label="摄像头面部捕捉" />
      </div>

      <div class="row">
        <div class="text">
          <span class="k">全局键鼠感知</span>
          <span class="d">用于判断「正在操作电脑」</span>
        </div>
        <M3Switch v-model="settings.globalInput" label="全局键鼠感知" />
      </div>

      <div class="note">
        <M3Icon name="info" :size="16" />
        <p>
          全局键鼠感知只统计「是否有输入」与输入速率，<strong>不记录按键内容、不落盘、不上传</strong>；
          前台窗口只判断是否全屏，不读取窗口标题。可随时关闭。
        </p>
      </div>
    </section>

    <section class="group">
      <h3>运行时</h3>
      <!-- 自 settings.html「角色与模型」区吸收；数据来自 /dsh-l2d/status.json，取不到显示「—」 -->
      <div class="about">
        <div class="about-row"><span>当前模型</span><code>{{ runtime?.model || '—' }}</code></div>
        <div class="about-row"><span>渲染包</span><code>{{ yesNo(runtime?.renderer) }}</code></div>
        <div class="about-row"><span>Cubism Core</span><code>{{ yesNo(runtime?.core) }}</code></div>
        <div class="about-row"><span>静态立绘</span><code>{{ yesNo(runtime?.avatarFound) }}</code></div>
      </div>
      <p v-if="runtimeError" class="runtime-hint">status.json 不可达（独立设置页 /dsh-l2d/settings.html 仍可直读运行时）。</p>
    </section>

    <section class="group">
      <h3>连接</h3>

      <div class="row col">
        <div class="text">
          <span class="k">运行时接口地址</span>
          <span class="d">角色运行时服务前缀</span>
        </div>
        <DshTextInput v-model="connect.endpoint" placeholder="/dsh-l2d/" @update:model-value="persistConnect" />
      </div>

      <div class="row col">
        <div class="text">
          <span class="k">传输通道</span>
          <span class="d">插件注入页走 /dsh-l2d/，调试页走 dev-server</span>
        </div>
        <DshSelect v-model="connect.transport" :options="transportOptions" @update:model-value="persistConnect" />
      </div>

      <div class="note">
        <M3Icon name="info" :size="16" />
        <p>
          连接项当前仅保存在本机（TODO：运行时写入通道未接通，settings.json 的读写仍由
          独立设置页承担，接通后此面板成为唯一设置面）。
        </p>
      </div>
    </section>

    <section class="group">
      <h3>关于</h3>
      <div class="about">
        <div class="about-row"><span>版本</span><code>0.1.0 · P0</code></div>
        <div class="about-row"><span>渲染内核</span><code>Cubism 5 Core（待接入）</code></div>
        <div class="about-row"><span>模型署名</span><code>DeepSeek-chan · 原画 神宫凉子 / 建模 霓虹猫_NeonNeko</code></div>
      </div>
      <div class="actions">
        <M3Button variant="outlined" icon="trash" size="sm" @click="resetSettings">恢复默认设置</M3Button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--dsh-space-5);
}

.group + .group {
  padding-top: var(--dsh-space-5);
  border-top: 1px solid var(--dsh-line);
}

.group h3 {
  margin: 0 0 var(--dsh-space-3);
  font: var(--dsh-text-lg);
  color: var(--dsh-ink);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dsh-space-4);
  padding: var(--dsh-space-3) 0;
  border-top: 1px solid var(--dsh-line);
}

.row:first-of-type {
  border-top: none;
}

.row.col {
  flex-direction: column;
  align-items: stretch;
  gap: var(--dsh-space-3);
}

.text {
  display: flex;
  flex-direction: column;
  gap: var(--dsh-space-1);
  min-width: 0;
}

.k {
  font: var(--dsh-text-label);
  color: var(--dsh-ink);
}

.d {
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}

.note {
  display: flex;
  gap: var(--dsh-space-3);
  margin-top: var(--dsh-space-3);
  padding: var(--dsh-space-4);
  border-radius: var(--dsh-radius-lg);
  background: var(--dsh-surface-raised);
  color: var(--dsh-ink-muted);
}

.note p {
  margin: 0;
  font: var(--dsh-text-xs);
}

.note strong {
  color: var(--dsh-ink);
  font-weight: 500;
}

.about {
  display: flex;
  flex-direction: column;
  gap: var(--dsh-space-2);
  padding: var(--dsh-space-4);
  border-radius: var(--dsh-radius-lg);
  background: var(--dsh-surface-raised);
}

.about-row {
  display: flex;
  justify-content: space-between;
  gap: var(--dsh-space-4);
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}

.about-row code {
  max-width: 68%;
  font: var(--dsh-text-xs);
  font-family: var(--dsh-font-mono);
  color: var(--dsh-ink);
  text-align: right;
  word-break: break-word;
}

.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--dsh-space-4);
}

.runtime-hint {
  margin: var(--dsh-space-2) 0 0;
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}

/* ===== BEGIN STUDIO ADAPT v1 ===== */
/* Editor-surface control states. Tokens are provided globally. No DOM/JS changes. */
:is(.topbar, .toolbar) { min-height: var(--studio-toolbar-h); }
:is(.statusbar) { min-height: var(--studio-statusbar-h); }
:is(.topbar, .sidebar, .dock, .panel, .sheet, .card, .head) {
  border-color: var(--studio-line);
  color: var(--studio-ink);
}
button, input, select, textarea, a, [role='button'] {
  transition: background var(--studio-transition-fast), border-color var(--studio-transition-fast),
    color var(--studio-transition-fast), box-shadow var(--studio-transition-fast),
    transform var(--studio-transition-fast);
}
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible,
a:focus-visible, [role='button']:focus-visible {
  outline: none;
  box-shadow: var(--studio-focus-ring);
}
button:active:not(:disabled), [role='button']:active:not(:disabled) { transform: translateY(1px); }
button:disabled, input:disabled, select:disabled, textarea:disabled, [data-state='disabled'] {
  opacity: var(--studio-state-disabled-opacity);
  cursor: not-allowed;
}
[data-state='loading'] { cursor: progress; }
[data-state='error'] { border-color: var(--studio-danger); color: var(--studio-danger); }
[data-state='success'] { border-color: var(--studio-ok); color: var(--studio-ok); }
[data-state='selected'], [data-state='active'] {
  background: var(--studio-selected);
  box-shadow: inset 2px 0 0 var(--studio-accent);
}
@media (max-width: 1023px) { :is(.topbar, .toolbar) { min-height: 44px; } }
@media (max-width: 719px) {
  :is(.topbar, .toolbar) { min-height: var(--studio-toolbar-h); }
}
@media (prefers-reduced-motion: reduce) {
  button, input, select, textarea, a, [role='button'] { transition: none !important; }
}
/* ===== END STUDIO ADAPT v1 ===== */
</style>
