<script setup lang="ts">
/**
 * DshTextInput —— 令牌化文本输入
 *
 * 映射表 B 节缺口控件：来源是 settings.html 原生 input 与 overlay.js `.l2d-row input` 规则。
 * 样式只从 ui-tokens.css 取 var(--dsh-…)：radius-md、sunken 底、accent 聚焦边。
 */
withDefaults(defineProps<{ modelValue: string; placeholder?: string; type?: string; disabled?: boolean }>(), {
  placeholder: '',
  type: 'text',
  disabled: false,
});
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <input
    class="dsh-text-input"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.dsh-text-input {
  width: 100%;
  box-sizing: border-box;
  height: var(--dsh-control-md);
  padding: 0 var(--dsh-space-3);
  border-radius: var(--dsh-radius-md);
  border: 1px solid var(--dsh-line);
  background: var(--dsh-surface-sunken);
  color: var(--dsh-ink);
  font: var(--dsh-text-md);
  outline: none;
  transition: border-color var(--dsh-dur-fast) var(--dsh-ease);
}

.dsh-text-input::placeholder {
  color: var(--dsh-ink-muted);
}

.dsh-text-input:hover:not(:disabled) {
  border-color: var(--dsh-line-strong);
}

.dsh-text-input:focus {
  border-color: var(--dsh-accent);
}

.dsh-text-input:disabled {
  opacity: var(--dsh-disabled-opacity);
  cursor: not-allowed;
}
</style>
