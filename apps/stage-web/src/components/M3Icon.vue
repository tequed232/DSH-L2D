<script setup lang="ts">
/**
 * M3Icon —— 内联图标集
 *
 * 设计取舍：不引 Google Fonts / Material Symbols CDN（国内网络不可靠，且离线不可用），
 * 改为内置一组 24dp 网格的线性图标，风格对齐 M3（1.8 描边、圆头、留白充足）。
 * 需要扩充时在 ICONS 里加一条即可，使用方只写 <M3Icon name="settings" />。
 */
import { computed } from 'vue';

const ICONS = {
  settings: '<path d="M4 7h4M12 7h8M4 17h8M16 17h4"/><circle cx="10" cy="7" r="2"/><circle cx="14" cy="17" r="2"/>',
  palette:
    '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.7 1.6-1.5 0-.6-.3-1-.3-1.6 0-.8.6-1.4 1.5-1.4H16a5 5 0 0 0 5-5c0-4.4-4-8.5-9-8.5Z"/><circle cx="8.2" cy="10.2" r="1.05"/><circle cx="12" cy="7.8" r="1.05"/><circle cx="15.8" cy="10.2" r="1.05"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  play: '<path d="M8.5 5.6v12.8L19 12z"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  mic: '<rect x="9" y="2.8" width="6" height="11" rx="3"/><path d="M5.2 11.2a6.8 6.8 0 0 0 13.6 0"/><path d="M12 18v3.2"/>',
  camera: '<rect x="3" y="6" width="18" height="13" rx="3.2"/><circle cx="12" cy="12.5" r="3.4"/>',
  keyboard:
    '<rect x="2.4" y="6.4" width="19.2" height="11.2" rx="2.8"/><path d="M6.4 10h.02M9.8 10h.02M13.2 10h.02M16.6 10h.02M8 13.6h8"/>',
  moon: '<path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
  check: '<path d="M4.8 12.4l4.8 4.8 9.6-10.4"/>',
  chevron: '<path d="M9.6 5.8l6.4 6.2-6.4 6.2"/>',
  folder:
    '<path d="M3 7.6A2.6 2.6 0 0 1 5.6 5h3.1l2 2.2h7.7A2.6 2.6 0 0 1 21 9.8v7.6A2.6 2.6 0 0 1 18.4 20H5.6A2.6 2.6 0 0 1 3 17.4Z"/>',
  eye: '<path d="M2.4 12S6 5.8 12 5.8 21.6 12 21.6 12 18 18.2 12 18.2 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11.2v5.4"/><circle cx="12" cy="7.9" r="0.9" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M12 3.2l1.9 5.3 5.3 1.9-5.3 1.9L12 17.6l-1.9-5.3L4.8 10.4l5.3-1.9z"/>',
  bolt: '<path d="M13.6 2.8L6 13.4h4.9l-.5 7.8L18 10.6h-4.9z"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.8 7l.9 12.2h8.6L17.2 7"/>',
  // ---- Companion Workspace（导航 / 对话 / 插件中心）----
  chat: '<path d="M4 6.8A2.8 2.8 0 0 1 6.8 4h10.4A2.8 2.8 0 0 1 20 6.8v7.4a2.8 2.8 0 0 1-2.8 2.8H10l-4.2 3.4a.6.6 0 0 1-1-.5V17A2.8 2.8 0 0 1 4 14.2Z"/><path d="M8.4 9.4h7.2M8.4 12.6h4.4"/>',
  plus: '<path d="M12 5.4v13.2M5.4 12h13.2"/>',
  puzzle:
    '<path d="M9.6 4.8a2.1 2.1 0 0 1 4.2 0V6h2.8a1.2 1.2 0 0 1 1.2 1.2V10h1.2a2.1 2.1 0 0 1 0 4.2h-1.2v2.8a1.2 1.2 0 0 1-1.2 1.2H13v-1.2a2.1 2.1 0 0 0-4.2 0V18H6a1.2 1.2 0 0 1-1.2-1.2v-2.8h1.2a2.1 2.1 0 0 0 0-4.2H4.8V7.2A1.2 1.2 0 0 1 6 6h3.6Z"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.9"/>',
  send: '<path d="M4.4 12 19.4 5l-3 14.4-4.6-5.2-3.8-1.2Z"/><path d="M11.8 14.2l3.8-4.6"/>',
  menu: '<path d="M4.4 7h15.2M4.4 12h15.2M4.4 17h15.2"/>',
} as const;

export type IconName = keyof typeof ICONS;

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 22 });

const markup = computed(() => ICONS[props.name]);
</script>

<template>
  <svg
    class="m3-icon"
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="markup"
  />
</template>

<style scoped>
.m3-icon {
  display: block;
  flex: none;
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
