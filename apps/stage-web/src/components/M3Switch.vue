<script setup lang="ts">
const props = withDefaults(
  defineProps<{ modelValue: boolean; label?: string; disabled?: boolean }>(),
  { disabled: false },
);
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const toggle = () => {
  if (!props.disabled) emit('update:modelValue', !props.modelValue);
};
</script>

<template>
  <button
    class="m3-switch"
    :class="{ on: props.modelValue }"
    role="switch"
    :aria-checked="props.modelValue"
    :aria-label="props.label"
    :disabled="props.disabled"
    type="button"
    @click="toggle"
  >
    <span class="track"><span class="thumb" /></span>
  </button>
</template>

<style scoped>
.m3-switch {
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  flex: none;
}

.m3-switch:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.track {
  display: grid;
  align-items: center;
  width: 52px;
  height: 32px;
  padding: 4px;
  border-radius: var(--shape-full);
  background: var(--surface-container-highest);
  box-shadow: inset 0 0 0 2px var(--outline);
  transition:
    background var(--dur-medium) var(--ease-standard),
    box-shadow var(--dur-medium) var(--ease-standard);
}

.on .track {
  background: var(--primary);
  box-shadow: inset 0 0 0 2px var(--primary);
}

.thumb {
  width: 16px;
  height: 16px;
  border-radius: var(--shape-full);
  background: var(--outline);
  transition:
    width var(--dur-medium) var(--ease-spring),
    height var(--dur-medium) var(--ease-spring),
    transform var(--dur-medium) var(--ease-spring),
    background var(--dur-medium) var(--ease-standard);
}

.on .thumb {
  width: 24px;
  height: 24px;
  transform: translateX(20px);
  background: var(--on-primary);
}
</style>
