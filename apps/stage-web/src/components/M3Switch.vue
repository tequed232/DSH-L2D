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
  /* 轨宽 44px = --dsh-control-md(40) + --dsh-space-1(4)：保持原视觉，不写死像素 */
  width: calc(var(--dsh-control-md) + var(--dsh-space-1));
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
  /* 位移 20px = 轨宽(44) - 左右内边距(2×4) - 滑块(16)，全部由令牌推导 */
  transform: translateX(calc(var(--dsh-control-md) - var(--dsh-space-1) - var(--dsh-space-4)));
  background: var(--dsh-on-accent);
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
