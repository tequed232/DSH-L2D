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
      <M3Icon v-if="opt.icon" :name="opt.icon" :size="17" />
      <span>{{ opt.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.m3-segmented {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--shape-full);
  background: var(--surface-container-high);
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
  gap: 6px;
  height: 34px;
  padding: 0 14px;
  border: none;
  border-radius: var(--shape-full);
  background: transparent;
  color: var(--on-surface-variant);
  font: var(--type-caption);
  font-weight: 500;
  cursor: pointer;
  transition:
    background var(--dur-medium) var(--ease-standard),
    color var(--dur-medium) var(--ease-standard);
}

.seg:hover:not(.active) {
  background: color-mix(in srgb, var(--on-surface) 6%, transparent);
}

.seg.active {
  background: var(--primary-container);
  color: var(--on-primary-container);
}
</style>
