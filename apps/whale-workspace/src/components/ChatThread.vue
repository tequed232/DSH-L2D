<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { ChatMessage } from '../services/types.ts';

const props = withDefaults(
  defineProps<{
    messages: readonly ChatMessage[];
    generating?: boolean;
    compact?: boolean;
    emptyText?: string;
  }>(),
  { generating: false, compact: false, emptyText: '还没有消息，先说点什么吧。' },
);

const viewport = ref<HTMLElement | null>(null);

function scrollToBottom(): void {
  const el = viewport.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

watch(
  () => [props.messages.length, props.messages.at(-1)?.text.length ?? 0, props.generating] as const,
  () => {
    void nextTick(scrollToBottom);
  },
  { immediate: true },
);
</script>

<template>
  <div ref="viewport" class="thread" :class="{ compact }">
    <p v-if="messages.length === 0" class="empty">{{ emptyText }}</p>

    <article
      v-for="message in messages"
      :key="message.id"
      class="row"
      :class="[message.role, { streaming: message.status === 'streaming' }]"
    >
      <span v-if="message.role === 'assistant'" class="avatar" aria-hidden="true">鲸</span>
      <div class="bubble">
        <p class="text">{{ message.text }}<span v-if="message.status === 'streaming'" class="caret" /></p>
        <span v-if="message.role === 'assistant' && message.status === 'streaming' && !message.text" class="typing">
          <i /><i /><i />
        </span>
      </div>
    </article>

    <article v-if="generating && messages.at(-1)?.role === 'user'" class="row assistant">
      <span class="avatar" aria-hidden="true">鲸</span>
      <div class="bubble">
        <span class="typing"><i /><i /><i /></span>
      </div>
    </article>
  </div>
</template>

<style scoped>
.thread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px var(--dsh-space-5);
  display: flex;
  flex-direction: column;
  gap: 14px;
  scroll-behavior: smooth;
}
.thread.compact {
  padding: 12px 14px;
  gap: 10px;
}

.empty {
  margin: auto;
  color: var(--dsh-ink-muted);
  font: var(--dsh-text-sm);
}

.row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  animation: row-in var(--dsh-dur) var(--dsh-ease) both;
}
.row.user {
  flex-direction: row-reverse;
}

.avatar {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font: var(--dsh-text-xs);
  color: #eef4ff;
  background: linear-gradient(135deg, var(--ww-violet-deep), var(--ww-cyan));
  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.12) inset;
}
.thread.compact .avatar {
  width: 22px;
  height: 22px;
  font-size: 10px;
}

.bubble {
  max-width: min(78%, 560px);
  padding: 10px 14px;
  border-radius: 14px 14px 14px 4px;
  background: color-mix(in srgb, var(--dsh-surface-raised) 86%, transparent);
  border: 1px solid var(--dsh-line);
  box-shadow: var(--dsh-shadow-1);
}
.row.user .bubble {
  border-radius: 14px 14px 4px 14px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--ww-violet-deep) 72%, #141a2c), #1c2440);
  border-color: color-mix(in srgb, var(--ww-violet) 34%, transparent);
}
.thread.compact .bubble {
  max-width: 84%;
  padding: 8px 11px;
  font: var(--dsh-text-sm);
}

.text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  background: currentColor;
  animation: caret 1s steps(2) infinite;
}

.row.streaming .bubble {
  border-color: color-mix(in srgb, var(--ww-violet) 40%, transparent);
}

@keyframes caret {
  50% {
    opacity: 0;
  }
}
@keyframes row-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .row {
    animation: none;
  }
  .caret {
    animation: none;
  }
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
