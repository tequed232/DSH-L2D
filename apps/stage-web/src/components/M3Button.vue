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
    <M3Icon v-if="props.icon" :name="props.icon" :size="props.size === 'sm' ? 18 : 20" />
    <span v-if="!props.iconOnly" class="label"><slot /></span>
  </button>
</template>

<style scoped>
.m3-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  border-radius: var(--shape-full);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--dur-short) var(--ease-standard),
    color var(--dur-short) var(--ease-standard),
    transform var(--dur-short) var(--ease-spring),
    box-shadow var(--dur-short) var(--ease-standard);
}

.m3-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.m3-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.s-md {
  height: 40px;
  padding: 0 20px;
  font: var(--type-label);
}
.s-sm {
  height: 32px;
  padding: 0 14px;
  font: var(--type-caption);
  font-weight: 500;
}

.is-icon-only.s-md {
  width: 40px;
  padding: 0;
}
.is-icon-only.s-sm {
  width: 32px;
  padding: 0;
}

.v-filled {
  background: var(--primary);
  color: var(--on-primary);
}
.v-filled:hover:not(:disabled) {
  box-shadow: var(--shadow-1);
  filter: brightness(1.06);
}

.v-tonal {
  background: var(--secondary-container);
  color: var(--on-secondary-container);
}
.v-tonal:hover:not(:disabled) {
  filter: brightness(1.12);
}

.v-outlined {
  background: transparent;
  color: var(--on-surface-variant);
  box-shadow: inset 0 0 0 1px var(--outline-variant);
}
.v-outlined:hover:not(:disabled) {
  background: color-mix(in srgb, var(--on-surface) 6%, transparent);
  box-shadow: inset 0 0 0 1px var(--outline);
}

.v-text {
  background: transparent;
  color: var(--primary);
  padding: 0 12px;
}
.v-text:hover:not(:disabled) {
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}

.label {
  line-height: 1;
}
</style>
