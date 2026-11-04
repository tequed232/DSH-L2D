<script setup lang="ts">
import { ref } from 'vue';
import M3Button from './components/M3Button.vue';
import M3Sheet from './components/M3Sheet.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import StageArea from './components/StageArea.vue';
import CompanionSidebar from './components/CompanionSidebar.vue';
import type { WorkspaceView } from './components/CompanionSidebar.vue';
import CompanionPanel from './components/CompanionPanel.vue';
import ChatArea from './components/ChatArea.vue';
import type { ChatMessage } from './components/ChatArea.vue';
import { useSettings } from './composables/useSettings.ts';

const { settings } = useSettings();
const settingsOpen = ref(false);
const view = ref<WorkspaceView>('companion');
const sidebarOpen = ref(false);
const avatarFailed = ref(false);

// TODO(接口边界)：对话服务未接入，消息列表暂为空，仅承载分层样式。
const messages = ref<ChatMessage[]>([]);

const toggleTheme = () => {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
};

const navigate = (v: WorkspaceView) => {
  view.value = v;
  sidebarOpen.value = false;
};

const openSettings = () => {
  settingsOpen.value = true;
  sidebarOpen.value = false;
};

const onPanelAction = (name: string) => {
  if (name === 'toggle-theme') toggleTheme();
  else if (name === 'open-settings') openSettings();
  else if (name === 'open-plugins') navigate('plugins');
};
</script>

<template>
  <div class="workspace" :class="{ 'sidebar-open': sidebarOpen }">
    <header class="topbar">
      <M3Button
        class="menu-btn"
        variant="text"
        icon="menu"
        icon-only
        size="sm"
        aria-label="打开导航"
        @click="sidebarOpen = !sidebarOpen"
      />
      <div class="names">
        <strong>DSH Companion</strong>
        <span>角色工作空间 · {{ view === 'companion' ? 'Companion' : 'Plugin Center' }}</span>
      </div>
      <span class="grow" />
      <M3Button
        variant="outlined"
        icon-only
        size="sm"
        :icon="settings.theme === 'dark' ? 'sun' : 'moon'"
        @click="toggleTheme"
      />
    </header>

    <div class="body">
      <CompanionSidebar
        class="sidebar"
        :active="view"
        @navigate="navigate"
        @new-chat="sidebarOpen = false"
        @open-settings="openSettings"
      />
      <div v-if="sidebarOpen" class="scrim" @click="sidebarOpen = false" />

      <main class="main">
        <template v-if="view === 'companion'">
          <div class="companion">
            <CompanionPanel class="companion-panel" v-model:avatar-failed="avatarFailed" @action="onPanelAction" />
            <div class="companion-right">
              <StageArea class="companion-stage" />
              <ChatArea class="companion-chat" :messages="messages" />
            </div>
          </div>
        </template>
        <PluginCenterView v-else />
      </main>
    </div>

    <M3Sheet :open="settingsOpen" title="设置" @close="settingsOpen = false">
      <SettingsPanel />
    </M3Sheet>
  </div>
</template>

<style scoped>
.workspace {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
  padding: var(--dsh-space-3) var(--dsh-space-4) var(--dsh-space-4);
  gap: var(--dsh-space-3);
}

.topbar {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-3);
}

.menu-btn {
  display: none;
}

.names {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.names strong {
  font: var(--dsh-text-lg);
}

.names span {
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}

.grow {
  flex: 1;
}

.body {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr;
  min-height: 0;
}

.sidebar {
  width: 232px;
  min-height: 0;
}

/* 窄屏：侧栏变抽屉，scrim 关闭 */
@media (max-width: 900px) {
  .menu-btn {
    display: inline-flex;
  }

  .body {
    grid-template-columns: 1fr;
  }

  .sidebar {
    position: absolute;
    z-index: var(--dsh-z-sheet);
    inset: 0 auto 0 0;
    width: min(280px, 82vw);
    transform: translateX(calc(-100% - var(--dsh-space-4)));
    transition: transform var(--dsh-dur) var(--dsh-ease);
    box-shadow: var(--dsh-shadow-3);
  }

  .sidebar-open .sidebar {
    transform: translateX(0);
  }

  .scrim {
    position: absolute;
    z-index: var(--dsh-z-scrim);
    inset: 0;
    border-radius: var(--dsh-radius-xl);
    background: var(--dsh-scrim);
  }
}

.main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.companion {
  display: grid;
  grid-template-columns: 264px 1fr;
  gap: var(--dsh-space-3);
  flex: 1;
  min-height: 0;
}

.companion-panel {
  min-height: 0;
}

.companion-right {
  display: grid;
  grid-template-rows: 1fr 220px;
  gap: var(--dsh-space-3);
  min-height: 0;
}

.companion-stage {
  min-height: 0;
}

.companion-chat {
  min-height: 0;
}

@media (max-width: 900px) {
  .companion {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    overflow-y: auto;
  }

  .companion-right {
    grid-template-rows: 1fr 200px;
  }
}
</style>
