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
</style>
