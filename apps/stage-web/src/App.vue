<script setup lang="ts">
import { ref } from 'vue';
import M3Icon from './components/M3Icon.vue';
import M3Button from './components/M3Button.vue';
import M3Sheet from './components/M3Sheet.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import StageArea from './components/StageArea.vue';
import { useSettings } from './composables/useSettings.ts';

const { settings } = useSettings();
const settingsOpen = ref(false);

const toggleTheme = () => {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
};
</script>

<template>
  <div class="app">
    <header class="bar">
      <div class="brand">
        <span class="logo"><M3Icon name="sparkle" :size="16" /></span>
        <div class="names">
          <strong>DSH-L2D</strong>
          <span>角色舞台 · P0</span>
        </div>
      </div>

      <div class="actions">
        <M3Button
          variant="outlined"
          icon-only
          size="sm"
          :icon="settings.theme === 'dark' ? 'sun' : 'moon'"
          @click="toggleTheme"
        />
        <M3Button variant="tonal" icon="settings" size="sm" @click="settingsOpen = true">设置</M3Button>
      </div>
    </header>

    <main class="main">
      <StageArea />
    </main>

    <M3Sheet :open="settingsOpen" title="设置" @close="settingsOpen = false">
      <SettingsPanel />
    </M3Sheet>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
  padding: var(--dsh-space-4);
  gap: var(--dsh-space-4);
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dsh-space-4);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-3);
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

.actions {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-2);
}

.main {
  min-height: 0;
}
</style>
