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
  gap: 12px;
}

.m3-slider.disabled {
  opacity: 0.38;
}

input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  min-width: 0;
  height: 24px;
  background: transparent;
  cursor: pointer;
}

input[type='range']::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: var(--shape-full);
  background: linear-gradient(
    to right,
    var(--primary) 0%,
    var(--primary) var(--p),
    var(--surface-container-highest) var(--p),
    var(--surface-container-highest) 100%
  );
}

input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  margin-top: -6px;
  border: 2px solid var(--surface-container-low);
  border-radius: var(--shape-full);
  background: var(--primary);
  transition: transform var(--dur-short) var(--ease-spring);
}

input[type='range']:active::-webkit-slider-thumb {
  transform: scale(1.15);
}

input[type='range']::-moz-range-track {
  height: 6px;
  border-radius: var(--shape-full);
  background: var(--surface-container-highest);
}

input[type='range']::-moz-range-progress {
  height: 6px;
  border-radius: var(--shape-full);
  background: var(--primary);
}

input[type='range']::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: 2px solid var(--surface-container-low);
  border-radius: var(--shape-full);
  background: var(--primary);
}

.suffix {
  min-width: 44px;
  text-align: right;
  font: var(--type-caption);
  font-variant-numeric: tabular-nums;
  color: var(--on-surface-variant);
}
</style>
