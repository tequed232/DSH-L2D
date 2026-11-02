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
  opacity: var(--dsh-disabled-opacity);
  cursor: not-allowed;
}

.track {
  display: grid;
  align-items: center;
  width: 44px;
  height: var(--dsh-space-5);
  padding: var(--dsh-space-1);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-surface-raised);
  box-shadow: inset 0 0 0 1px var(--dsh-line-strong);
  transition:
    background var(--dsh-dur) var(--dsh-ease),
    box-shadow var(--dsh-dur) var(--dsh-ease);
}

.on .track {
  background: var(--dsh-accent);
  box-shadow: inset 0 0 0 1px var(--dsh-accent);
}

.thumb {
  width: var(--dsh-space-4);
  height: var(--dsh-space-4);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-ink-muted);
  transition:
    transform var(--dsh-dur) var(--dsh-ease),
    background var(--dsh-dur) var(--dsh-ease);
}

.on .thumb {
  transform: translateX(20px);
  background: var(--dsh-on-accent);
}
</style>
