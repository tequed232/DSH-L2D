<script setup lang="ts">
import M3Icon from './M3Icon.vue';
import type { IconName } from './M3Icon.vue';

const props = withDefaults(
  defineProps<{
    variant?: 'filled' | 'tonal' | 'outlined' | 'text';
    icon?: IconName;
    iconOnly?: boolean;
    size?: 'sm' | 'md';
    disabled?: boolean;
  }>(),
  { variant: 'filled', iconOnly: false, size: 'md', disabled: false },
);
</script>

<template>
  <button
    class="m3-btn"
    :class="[`v-${props.variant}`, `s-${props.size}`, { 'is-icon-only': props.iconOnly }]"
    :disabled="props.disabled"
    type="button"
  >
    <M3Icon v-if="props.icon" :name="props.icon" :size="props.size === 'sm' ? 16 : 20" />
    <span v-if="!props.iconOnly" class="label"><slot /></span>
  </button>
</template>

<style scoped>
.m3-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--dsh-space-2);
  border: none;
  border-radius: var(--dsh-radius-md);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--dsh-dur-fast) var(--dsh-ease),
    color var(--dsh-dur-fast) var(--dsh-ease),
    box-shadow var(--dsh-dur-fast) var(--dsh-ease);
}

.m3-btn:disabled {
  opacity: var(--dsh-disabled-opacity);
  cursor: not-allowed;
}

.s-md {
  height: var(--dsh-control-md);
  padding: 0 var(--dsh-space-4);
  font: var(--dsh-text-label);
}
.s-sm {
  height: var(--dsh-control-sm);
  padding: 0 var(--dsh-space-3);
  font: var(--dsh-text-xs);
  font-weight: 500;
}

.is-icon-only.s-md {
  width: var(--dsh-control-md);
  padding: 0;
}
.is-icon-only.s-sm {
  width: var(--dsh-control-sm);
  padding: 0;
}

.v-filled {
  background: var(--dsh-accent);
  color: var(--dsh-on-accent);
}
.v-filled:hover:not(:disabled) {
  box-shadow: var(--dsh-shadow-1);
}

.v-tonal {
  background: var(--dsh-accent-soft);
  color: var(--dsh-on-accent-soft);
}
.v-tonal:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsh-accent-soft) 82%, var(--dsh-ink));
}

.v-outlined {
  background: transparent;
  color: var(--dsh-ink-muted);
  box-shadow: inset 0 0 0 1px var(--dsh-line);
}
.v-outlined:hover:not(:disabled) {
  background: var(--dsh-hover);
  color: var(--dsh-ink);
  box-shadow: inset 0 0 0 1px var(--dsh-line-strong);
}

.v-text {
  background: transparent;
  color: var(--dsh-accent);
  padding: 0 var(--dsh-space-3);
}
.v-text:hover:not(:disabled) {
  background: var(--dsh-accent-soft);
}

.label {
  line-height: 1;
}
</style>
