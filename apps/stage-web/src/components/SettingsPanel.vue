<script setup lang="ts">
import { computed } from 'vue';
import M3Segmented from './M3Segmented.vue';
import type { SegmentOption } from './M3Segmented.vue';
import M3Slider from './M3Slider.vue';
import M3Switch from './M3Switch.vue';
import M3Button from './M3Button.vue';
import M3Icon from './M3Icon.vue';
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
</style>
