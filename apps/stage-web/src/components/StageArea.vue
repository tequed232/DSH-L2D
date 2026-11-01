<script setup lang="ts">
import { computed } from 'vue';
import M3Button from './M3Button.vue';
import M3Icon from './M3Icon.vue';
import { useSettings } from '../composables/useSettings.ts';
import type { ContextState } from '../composables/useSettings.ts';

const { settings } = useSettings();

const CONTEXT_LABEL: Record<ContextState, string> = {
  idle: '待机',
  conversation: '问答中',
  work: '操作电脑',
  away: '离席',
};

const contextLabel = computed(() => CONTEXT_LABEL[settings.contextPreview]);
</script>

<template>
  <div class="stage">
    <div class="canvas">
      <div class="placeholder">
        <div class="badge"><M3Icon name="sparkle" :size="26" /></div>
        <h1>尚未加载模型</h1>
        <p>
          把模型文件夹放入 <code>models/</code> 后导入。<br />
          渲染内核需从 Live2D 官方 SDK 提取 <code>live2dcubismcore.min.js</code>。
        </p>
        <div class="cta">
          <M3Button icon="folder">导入模型</M3Button>
          <M3Button variant="text" icon="info">接入说明</M3Button>
        </div>
      </div>

      <span class="ctx-pill" :class="`ctx-${settings.contextPreview}`">
        <i />{{ contextLabel }}
      </span>
    </div>

    <footer class="status">
      <span class="item"><em>情境</em>{{ contextLabel }}</span>
      <span class="sep" />
      <span class="item"><em>帧率</em>—</span>
      <span class="sep" />
      <span class="item"><em>参数</em>—</span>
      <span class="sep" />
      <span class="item"><em>通道</em>0</span>
      <span class="grow" />
      <span class="item dim">P0 · 骨架</span>
    </footer>
  </div>
</template>

<style scoped>
.stage {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 12px;
}

.canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  border-radius: var(--shape-xl);
  background:
    radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--primary) 10%, transparent), transparent 62%),
    var(--surface-container-low);
  box-shadow: inset 0 0 0 1px var(--outline-variant);
  overflow: hidden;
}

.canvas::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(to right, var(--outline-variant) 1px, transparent 1px),
    linear-gradient(to bottom, var(--outline-variant) 1px, transparent 1px);
  background-size: 40px 40px;
  opacity: 0.18;
  mask-image: radial-gradient(circle at 50% 45%, #000, transparent 72%);
  pointer-events: none;
}

.placeholder {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 32px;
  text-align: center;
}

.badge {
  display: grid;
  place-items: center;
  width: 60px;
  height: 60px;
  margin-bottom: 6px;
  border-radius: var(--shape-lg);
  background: var(--primary-container);
  color: var(--on-primary-container);
}

h1 {
  margin: 0;
  font: var(--type-headline);
  color: var(--on-surface);
}

p {
  margin: 0;
  max-width: 30em;
  font: var(--type-body);
  color: var(--on-surface-variant);
}

code {
  padding: 1px 6px;
  border-radius: var(--shape-xs);
  background: var(--surface-container-high);
  font-family: var(--font-mono);
  font-size: 12px;
}

.cta {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.ctx-pill {
  position: absolute;
  top: 16px;
  left: 16px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 14px;
  border-radius: var(--shape-full);
  background: var(--surface-container-high);
  color: var(--on-surface-variant);
  font: var(--type-caption);
  font-weight: 500;
}

.ctx-pill i {
  width: 7px;
  height: 7px;
  border-radius: var(--shape-full);
  background: var(--outline);
}

.ctx-idle i {
  background: var(--outline);
}
.ctx-conversation i {
  background: var(--primary);
}
.ctx-work i {
  background: var(--tertiary);
}
.ctx-away i {
  background: var(--outline-variant);
}

.status {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 18px;
  border-radius: var(--shape-full);
  background: var(--surface-container);
  font: var(--type-caption);
  color: var(--on-surface);
}

.item {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
}

.item em {
  font-style: normal;
  color: var(--on-surface-variant);
}

.item.dim {
  color: var(--on-surface-variant);
}

.sep {
  width: 1px;
  height: 12px;
  background: var(--outline-variant);
}

.grow {
  flex: 1;
}
</style>
