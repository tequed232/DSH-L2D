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
        <span class="logo"><M3Icon name="sparkle" :size="17" /></span>
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
  padding: 14px 18px 16px;
  gap: 14px;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: var(--shape-md);
  background: var(--primary-container);
  color: var(--on-primary-container);
}

.names {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.names strong {
  font: var(--type-title);
  font-weight: 500;
  letter-spacing: 0.3px;
}

.names span {
  font: var(--type-caption);
  color: var(--on-surface-variant);
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.main {
  min-height: 0;
}
</style>
