<script setup lang="ts">
/**
 * CompanionSidebar —— 工作空间左侧/抽屉导航
 *
 * 分层铁律：本组件只呈现状态与分发交互，不持有业务状态机。
 * 最近对话当前为占位数据（TODO：接对话持久化接口后替换）。
 */
import M3Icon from './M3Icon.vue';
import M3Button from './M3Button.vue';

export type WorkspaceView = 'companion' | 'plugins';

defineProps<{ active: WorkspaceView }>();
const emit = defineEmits<{ navigate: [view: WorkspaceView]; newChat: []; openSettings: [] }>();

// TODO(接口边界)：最近对话应来自对话持久化服务；占位数据仅用于布局验收。
const recentChats = [
  { id: 'placeholder-1', title: '（占位）关于模型导入的讨论' },
  { id: 'placeholder-2', title: '（占位）行为参数调优' },
  { id: 'placeholder-3', title: '（占位）插件中心巡检' },
];

const navItems: Array<{ view: WorkspaceView; icon: 'chat' | 'puzzle'; label: string }> = [
  { view: 'companion', icon: 'chat', label: 'Companion' },
  { view: 'plugins', icon: 'puzzle', label: 'Plugin Center' },
];
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="logo"><M3Icon name="sparkle" :size="16" /></span>
      <strong>DSH Companion</strong>
    </div>

    <M3Button icon="plus" variant="tonal" size="sm" @click="emit('newChat')">新建对话</M3Button>

    <nav class="nav">
      <button
        v-for="item in navItems"
        :key="item.view"
        class="nav-item"
        :class="{ active: active === item.view }"
        type="button"
        @click="emit('navigate', item.view)"
      >
        <M3Icon :name="item.icon" :size="18" />
        <span>{{ item.label }}</span>
      </button>
      <button class="nav-item" type="button" @click="emit('openSettings')">
        <M3Icon name="settings" :size="18" />
        <span>Settings</span>
      </button>
    </nav>

    <div class="recent">
      <div class="recent-head"><M3Icon name="clock" :size="14" /><span>最近对话</span></div>
      <ul>
        <li v-for="chat in recentChats" :key="chat.id" class="recent-item" :title="chat.title">
          {{ chat.title }}
        </li>
      </ul>
      <!-- TODO(接口边界)：对话列表/历史接口未定义，占位数据不宣称真实 -->
    </div>

    <div class="user">
      <!-- TODO(接口边界)：账号体系未接入，先本地占位 -->
      <span class="avatar"><M3Icon name="user" :size="16" /></span>
      <span class="user-name">本地用户</span>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--dsh-space-4);
  padding: var(--dsh-space-4) var(--dsh-space-3);
  border-radius: var(--dsh-radius-xl);
  background: var(--dsh-surface);
  box-shadow: inset 0 0 0 1px var(--dsh-line);
  min-height: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-2);
  padding: 0 var(--dsh-space-1);
}

.brand strong {
  font: var(--dsh-text-lg);
  color: var(--dsh-ink);
}

.logo {
  display: grid;
  place-items: center;
  width: var(--dsh-control-sm);
  height: var(--dsh-control-sm);
  border-radius: var(--dsh-radius-md);
  background: var(--dsh-accent-soft);
  color: var(--dsh-on-accent-soft);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: var(--dsh-space-1);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-3);
  height: var(--dsh-control-sm);
  padding: 0 var(--dsh-space-3);
  border: none;
  border-radius: var(--dsh-radius-md);
  background: transparent;
  color: var(--dsh-ink-muted);
  font: var(--dsh-text-label);
  cursor: pointer;
  text-align: left;
  transition:
    background var(--dsh-dur-fast) var(--dsh-ease),
    color var(--dsh-dur-fast) var(--dsh-ease);
}

.nav-item:hover {
  background: var(--dsh-hover);
  color: var(--dsh-ink);
}

.nav-item.active {
  background: var(--dsh-accent-soft);
  color: var(--dsh-on-accent-soft);
}

.recent {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--dsh-space-2);
  padding-top: var(--dsh-space-3);
  border-top: 1px solid var(--dsh-line);
}

.recent-head {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-2);
  padding: 0 var(--dsh-space-3);
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}

.recent ul {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  min-height: 0;
}

.recent-item {
  padding: var(--dsh-space-2) var(--dsh-space-3);
  border-radius: var(--dsh-radius-md);
  font: var(--dsh-text-sm);
  color: var(--dsh-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background var(--dsh-dur-fast) var(--dsh-ease);
}

.recent-item:hover {
  background: var(--dsh-hover);
  color: var(--dsh-ink);
}

.user {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-3);
  padding: var(--dsh-space-2) var(--dsh-space-3);
  border-radius: var(--dsh-radius-lg);
  background: var(--dsh-surface-raised);
  cursor: pointer;
  transition: background var(--dsh-dur-fast) var(--dsh-ease);
}

.user:hover {
  background: var(--dsh-hover);
}

.avatar {
  display: grid;
  place-items: center;
  width: var(--dsh-control-sm);
  height: var(--dsh-control-sm);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-accent-soft);
  color: var(--dsh-on-accent-soft);
}

.user-name {
  font: var(--dsh-text-sm);
  color: var(--dsh-ink);
}
</style>
