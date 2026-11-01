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
          <span class="d">M3 Expressive · 跟随选择</span>
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
        <M3Icon name="info" :size="18" />
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
  gap: 28px;
}

.group + .group {
  padding-top: 22px;
  border-top: 1px solid var(--outline-variant);
}

.group h3 {
  margin: 0 0 12px;
  font: var(--type-title);
  color: var(--primary);
  letter-spacing: 0.2px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px solid var(--outline-variant);
}

.row:first-of-type {
  border-top: none;
}

.row.col {
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}

.text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.k {
  font: var(--type-label);
  color: var(--on-surface);
}

.d {
  font: var(--type-caption);
  color: var(--on-surface-variant);
}

.note {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  padding: 14px 16px;
  border-radius: var(--shape-md);
  background: var(--surface-container);
  color: var(--on-surface-variant);
}

.note p {
  margin: 0;
  font: var(--type-caption);
}

.note strong {
  color: var(--on-surface);
  font-weight: 500;
}

.about {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-radius: var(--shape-md);
  background: var(--surface-container);
}

.about-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font: var(--type-caption);
  color: var(--on-surface-variant);
}

.about-row code {
  max-width: 68%;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--on-surface);
  text-align: right;
  word-break: break-word;
}

.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
