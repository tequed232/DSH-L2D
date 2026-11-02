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
        <div class="badge"><M3Icon name="sparkle" :size="24" /></div>
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
  gap: var(--dsh-space-3);
}

.canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  border-radius: var(--dsh-radius-xl);
  background:
    radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--dsh-accent) 8%, transparent), transparent 58%),
    var(--dsh-surface);
  box-shadow: inset 0 0 0 1px var(--dsh-line);
  overflow: hidden;
}

.canvas::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(to right, var(--dsh-line) 1px, transparent 1px),
    linear-gradient(to bottom, var(--dsh-line) 1px, transparent 1px);
  background-size: var(--dsh-space-7) var(--dsh-space-7);
  opacity: 0.7;
  mask-image: radial-gradient(circle at 50% 45%, black, transparent 72%);
  pointer-events: none;
}

.placeholder {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--dsh-space-2);
  padding: var(--dsh-space-6);
  text-align: center;
}

.badge {
  display: grid;
  place-items: center;
  width: var(--dsh-space-8);
  height: var(--dsh-space-8);
  margin-bottom: var(--dsh-space-2);
  border-radius: var(--dsh-radius-lg);
  background: var(--dsh-accent-soft);
  color: var(--dsh-on-accent-soft);
}

h1 {
  margin: 0;
  font: var(--dsh-text-2xl);
  color: var(--dsh-ink);
}

p {
  margin: 0;
  max-width: 30em;
  font: var(--dsh-text-md);
  color: var(--dsh-ink-muted);
}

code {
  padding: 0 var(--dsh-space-1);
  border-radius: var(--dsh-radius-sm);
  background: var(--dsh-surface-raised);
  font: var(--dsh-text-xs);
  font-family: var(--dsh-font-mono);
}

.cta {
  display: flex;
  gap: var(--dsh-space-2);
  margin-top: var(--dsh-space-2);
}

.ctx-pill {
  position: absolute;
  top: var(--dsh-space-4);
  left: var(--dsh-space-4);
  display: inline-flex;
  align-items: center;
  gap: var(--dsh-space-2);
  height: var(--dsh-control-sm);
  padding: 0 var(--dsh-space-3);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-surface-raised);
  color: var(--dsh-ink-muted);
  font: var(--dsh-text-xs);
  font-weight: 500;
}

.ctx-pill i {
  width: 8px;
  height: 8px;
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-ink-muted);
}

.ctx-idle i {
  background: var(--dsh-ink-muted);
}
.ctx-conversation i {
  background: var(--dsh-accent);
}
.ctx-work i {
  background: var(--dsh-accent-muted);
}
.ctx-away i {
  background: var(--dsh-line-strong);
}

.status {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-3);
  padding: var(--dsh-space-2) var(--dsh-space-4);
  border-radius: var(--dsh-radius-lg);
  background: var(--dsh-surface);
  box-shadow: inset 0 0 0 1px var(--dsh-line);
  font: var(--dsh-text-xs);
  color: var(--dsh-ink);
}

.item {
  display: inline-flex;
  align-items: baseline;
  gap: var(--dsh-space-2);
  white-space: nowrap;
}

.item em {
  font-style: normal;
  color: var(--dsh-ink-muted);
}

.item.dim {
  color: var(--dsh-ink-muted);
}

.sep {
  width: 1px;
  height: var(--dsh-space-3);
  background: var(--dsh-line);
}

.grow {
  flex: 1;
}
</style>
