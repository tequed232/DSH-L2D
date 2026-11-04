<script setup lang="ts">
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    busy?: boolean;
    compact?: boolean;
    placeholder?: string;
    disabled?: boolean;
  }>(),
  { busy: false, compact: false, placeholder: '和鲸鱼娘说点什么…（Enter 发送 / Shift+Enter 换行）', disabled: false },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
  (event: 'send'): void;
}>();

const composing = ref(false);
const canSend = computed(() => props.modelValue.trim().length > 0 && !props.disabled && !props.busy);

function onInput(event: Event): void {
  const target = event.target as HTMLTextAreaElement;
  emit('update:modelValue', target.value);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return;
  // 中文输入法选词回车不能触发发送
  if (composing.value || event.isComposing) return;
  event.preventDefault();
  if (canSend.value) emit('send');
}
</script>

<template>
  <div class="composer" :class="{ compact }">
    <textarea
      :value="modelValue"
      :placeholder="placeholder"
      :rows="compact ? 1 : 2"
      :disabled="disabled"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
      @compositionstart="composing = true"
      @compositionend="composing = false"
    />
    <button class="ww-btn primary send" type="button" :disabled="!canSend" @click="emit('send')">
      <span v-if="busy" class="typing"><i /><i /><i /><span class="busy-text">生成中</span></span>
      <span v-else>发送</span>
    </button>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--dsh-line);
  background: color-mix(in srgb, var(--dsh-surface) 82%, transparent);
}
.composer.compact {
  padding: 8px 10px;
  gap: 8px;
}

textarea {
  flex: 1;
  resize: none;
  border-radius: var(--dsh-radius-lg);
  border: 1px solid var(--dsh-line);
  background: color-mix(in srgb, var(--dsh-surface-sunken) 70%, transparent);
  color: var(--dsh-ink);
  padding: 9px 12px;
  line-height: 1.5;
  max-height: 120px;
  min-height: 40px;
}
textarea:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--ww-violet) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ww-violet) 18%, transparent);
}
textarea::placeholder {
  color: color-mix(in srgb, var(--dsh-ink-muted) 78%, transparent);
}

.send {
  height: 40px;
  min-width: 64px;
}
.send .typing {
  color: #fff;
  gap: 3px;
}
.busy-text {
  margin-left: 4px;
  font: var(--dsh-text-xs);
}
</style>
