<script setup lang="ts">
/**
 * DshSelect —— 令牌化下拉选择
 *
 * 映射表 B 节缺口控件：来源是 settings.html 原生 select 与 overlay.js `.l2d-row select` 规则。
 * 样式只从 ui-tokens.css 取 var(--dsh-…)；选项由使用方传入，接口保持原生 select 语义。
 */
import M3Icon from './M3Icon.vue';

export interface SelectOption {
  value: string;
  label: string;
}

defineProps<{ modelValue: string; options: SelectOption[]; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <span class="dsh-select">
    <select
      class="dsh-select-native"
      :value="modelValue"
      :disabled="disabled"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
    </select>
    <span class="dsh-select-caret"><M3Icon name="chevron" :size="14" /></span>
  </span>
</template>

<style scoped>
.dsh-select {
  position: relative;
  display: inline-flex;
  width: 100%;
}

.dsh-select-native {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  box-sizing: border-box;
  height: var(--dsh-control-md);
  padding: 0 calc(var(--dsh-space-5) + var(--dsh-space-2)) 0 var(--dsh-space-3);
  border-radius: var(--dsh-radius-md);
  border: 1px solid var(--dsh-line);
  background: var(--dsh-surface-sunken);
  color: var(--dsh-ink);
  font: var(--dsh-text-md);
  outline: none;
  cursor: pointer;
  transition: border-color var(--dsh-dur-fast) var(--dsh-ease);
}

.dsh-select-native:hover:not(:disabled) {
  border-color: var(--dsh-line-strong);
}

.dsh-select-native:focus {
  border-color: var(--dsh-accent);
}

.dsh-select-native:disabled {
  opacity: var(--dsh-disabled-opacity);
  cursor: not-allowed;
}

.dsh-select-caret {
  position: absolute;
  right: var(--dsh-space-3);
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  rotate: 90deg;
  color: var(--dsh-ink-muted);
  pointer-events: none;
}
</style>
