<script setup lang="ts">
/**
 * CompanionPanel —— 角色展示与对话分离的角色面板
 *
 * 状态指示从真实运行时状态源读取：useSettings().contextPreview（与 StageArea 同源），
 * 不得写死。行为系统输出更细分的状态（聆听/思考等）后在此映射表追加即可。
 */
import { computed } from 'vue';
import M3Icon from './M3Icon.vue';
import M3Button from './M3Button.vue';
import { useSettings } from '../composables/useSettings.ts';
import type { ContextState } from '../composables/useSettings.ts';

const emit = defineEmits<{ action: [name: string] }>();

const { settings } = useSettings();

// 状态胶囊文案与 StageArea 保持一致（同一状态源，两处呈现）
const STATUS_LABEL: Record<ContextState, string> = {
  idle: '空闲',
  conversation: '响应中',
  work: '操作电脑',
  away: '离席',
};

// 「预览」尾缀：此胶囊来自 UI 预览状态源（settings.contextPreview），非真实运行时感知，
// 显式标注防止误读为真实状态（2026-11-05 审计 A5）。
const statusLabel = computed(() => `${STATUS_LABEL[settings.contextPreview]}（预览）`);

// 立绘走插件现有只读路由；加载失败回退内置剪影，不出现破图。
// 运行时绑定（:src）避免 Vite 把绝对 URL 当模块解析。
const AVATAR_URL = '/dsh-l2d/avatar.png';
const avatarFailed = defineModel<boolean>('avatarFailed', { default: false });

const quickActions: Array<{ name: string; icon: 'sparkle' | 'moon' | 'mic' | 'camera' | 'settings'; label: string; todo?: boolean }> = [
  { name: 'toggle-theme', icon: 'moon', label: '切换主题' },
  { name: 'open-settings', icon: 'settings', label: '设置' },
  // TODO(接口边界)：语音/视觉通道未接通，先禁用占位，不伪造可用
  { name: 'voice', icon: 'mic', label: '语音对话', todo: true },
  { name: 'vision', icon: 'camera', label: '视觉面捕', todo: true },
];
</script>

<template>
  <aside class="panel">
    <div class="portrait">
      <img
        v-if="!avatarFailed"
        class="portrait-img"
        :src="AVATAR_URL"
        alt="角色立绘"
        draggable="false"
        @error="avatarFailed = true"
      />
      <div v-else class="portrait-fallback" />
      <span class="status-pill" :class="`st-${settings.contextPreview}`"><i />{{ statusLabel }}</span>
    </div>

    <div class="quick">
      <div class="quick-head">快捷操作</div>
      <div class="quick-grid">
        <template v-for="act in quickActions" :key="act.name">
          <M3Button
            v-if="!act.todo"
            variant="outlined"
            :icon="act.icon"
            size="sm"
            @click="emit('action', act.name)"
          >{{ act.label }}</M3Button>
          <M3Button
            v-else
            variant="outlined"
            :icon="act.icon"
            size="sm"
            disabled
            :title="`TODO：${act.label}通道未接入`"
          >{{ act.label }}</M3Button>
        </template>
      </div>
    </div>

    <div class="entries">
      <div class="quick-head">动作入口</div>
      <button class="entry" type="button" @click="emit('action', 'open-plugins')">
        <M3Icon name="puzzle" :size="16" />
        <span>前往 Plugin Center</span>
        <M3Icon name="chevron" :size="14" />
      </button>
      <button class="entry" type="button" @click="emit('action', 'open-settings')">
        <M3Icon name="settings" :size="16" />
        <span>行为与性能设置</span>
        <M3Icon name="chevron" :size="14" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--dsh-space-4);
  padding: var(--dsh-space-4);
  border-radius: var(--dsh-radius-xl);
  background: var(--dsh-surface);
  box-shadow: inset 0 0 0 1px var(--dsh-line);
  overflow-y: auto;
  min-height: 0;
}

.portrait {
  position: relative;
  display: grid;
  place-items: center;
  padding: var(--dsh-space-5) var(--dsh-space-4);
  border-radius: var(--dsh-radius-lg);
  background:
    radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--dsh-accent) 10%, transparent), transparent 62%),
    var(--dsh-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--dsh-line);
}

.portrait-img {
  width: 100%;
  max-height: var(--dsh-space-8);
  object-fit: contain;
  filter: var(--dsh-shadow-drop);
}

/* 立绘缺失时的内置剪影（同 overlay 占位轮廓语义，不算界面圆角豁免外的违规） */
.portrait-fallback {
  width: 56%;
  aspect-ratio: 1 / 1.2;
  border-radius: 46% 46% 42% 42%;
  background: linear-gradient(160deg, var(--dsh-accent), var(--dsh-accent-muted));
  box-shadow: var(--dsh-shadow-2);
}

.status-pill {
  position: absolute;
  top: var(--dsh-space-3);
  left: var(--dsh-space-3);
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

.status-pill i {
  width: var(--dsh-space-2);
  height: var(--dsh-space-2);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-ink-muted);
}

.st-idle i {
  background: var(--dsh-ink-muted);
}
.st-conversation i {
  background: var(--dsh-accent);
}
.st-work i {
  background: var(--dsh-accent-muted);
}
.st-away i {
  background: var(--dsh-line-strong);
}

.quick-head {
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
  margin-bottom: var(--dsh-space-2);
}

.quick-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--dsh-space-2);
}

.entries {
  display: flex;
  flex-direction: column;
}

.entry {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-3);
  height: var(--dsh-control-sm);
  padding: 0 var(--dsh-space-3);
  border: none;
  border-radius: var(--dsh-radius-md);
  background: transparent;
  color: var(--dsh-ink);
  font: var(--dsh-text-sm);
  cursor: pointer;
  text-align: left;
  transition: background var(--dsh-dur-fast) var(--dsh-ease);
}

.entry:hover {
  background: var(--dsh-hover);
}

.entry span:first-of-type {
  flex: 1;
}
</style>
