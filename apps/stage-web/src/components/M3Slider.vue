<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    suffix?: string;
    disabled?: boolean;
  }>(),
  { min: 0, max: 1, step: 0.01, disabled: false },
);

const emit = defineEmits<{ 'update:modelValue': [value: number] }>();

const pct = computed(() => {
  const span = props.max - props.min || 1;
  return Math.min(100, Math.max(0, ((props.modelValue - props.min) / span) * 100));
});

const onChange = (e: Event) => {
  emit('update:modelValue', Number((e.target as HTMLInputElement).value));
};
</script>

<template>
  <div class="m3-slider" :class="{ disabled: props.disabled }">
    <input
      type="range"
      :value="props.modelValue"
      :min="props.min"
      :max="props.max"
      :step="props.step"
      :disabled="props.disabled"
      :style="{ '--p': pct + '%' }"
      @input="onChange"
    />
    <span v-if="props.suffix" class="suffix">{{ props.suffix }}</span>
  </div>
</template>

<style scoped>
.m3-slider {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-3);
}

.m3-slider.disabled {
  opacity: var(--dsh-disabled-opacity);
}

input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  min-width: 0;
  height: var(--dsh-space-5);
  background: transparent;
  cursor: pointer;
}

input[type='range']::-webkit-slider-runnable-track {
  height: var(--dsh-space-1);
  border-radius: var(--dsh-radius-full);
  background: linear-gradient(
    to right,
    var(--dsh-accent) 0%,
    var(--dsh-accent) var(--p),
    var(--dsh-surface-raised) var(--p),
    var(--dsh-surface-raised) 100%
  );
}

input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: var(--dsh-space-4);
  height: var(--dsh-space-4);
  margin-top: -6px;
  border: 2px solid var(--dsh-surface);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-accent);
}

input[type='range']::-moz-range-track {
  height: var(--dsh-space-1);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-surface-raised);
}

input[type='range']::-moz-range-progress {
  height: var(--dsh-space-1);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-accent);
}

input[type='range']::-moz-range-thumb {
  width: var(--dsh-space-4);
  height: var(--dsh-space-4);
  border: 2px solid var(--dsh-surface);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-accent);
}

.suffix {
  min-width: var(--dsh-space-8);
  text-align: right;
  font: var(--dsh-text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--dsh-ink-muted);
}
</style>
