<script setup lang="ts">
import M3Icon from './M3Icon.vue';
import type { IconName } from './M3Icon.vue';

export interface SegmentOption {
  value: string;
  label: string;
  icon?: IconName;
}

const props = defineProps<{
  modelValue: string;
  options: SegmentOption[];
  full?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="m3-segmented" :class="{ full: props.full }" role="tablist">
    <button
      v-for="opt in props.options"
      :key="opt.value"
      class="seg"
      :class="{ active: opt.value === props.modelValue }"
      role="tab"
      :aria-selected="opt.value === props.modelValue"
      type="button"
      @click="emit('update:modelValue', opt.value)"
    >
      <M3Icon v-if="opt.icon" :name="opt.icon" :size="16" />
      <span>{{ opt.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.m3-segmented {
  display: inline-flex;
  gap: var(--dsh-space-1);
  padding: var(--dsh-space-1);
  border-radius: var(--dsh-radius-md);
  background: var(--dsh-surface-sunken);
}

.m3-segmented.full {
  display: flex;
  width: 100%;
}

.full .seg {
  flex: 1;
}

.seg {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--dsh-space-2);
  height: var(--dsh-control-sm);
  padding: 0 var(--dsh-space-3);
  border: none;
  border-radius: var(--dsh-radius-sm);
  background: transparent;
  color: var(--dsh-ink-muted);
  font: var(--dsh-text-xs);
  font-weight: 500;
  cursor: pointer;
  transition:
    background var(--dsh-dur) var(--dsh-ease),
    color var(--dsh-dur) var(--dsh-ease),
    box-shadow var(--dsh-dur) var(--dsh-ease);
}

.seg:hover:not(.active) {
  background: var(--dsh-hover);
  color: var(--dsh-ink);
}

.seg.active {
  background: var(--dsh-surface);
  color: var(--dsh-ink);
  box-shadow: var(--dsh-shadow-1);
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
