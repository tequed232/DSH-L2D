<script setup lang="ts">
import type { ConversationSnapshot } from '../services/types.ts';

const props = withDefaults(
  defineProps<{
    conversations: readonly ConversationSnapshot[];
    currentId: string;
    unread: Readonly<Record<string, number>>;
    canCreate?: boolean;
    compact?: boolean;
  }>(),
  { canCreate: true, compact: false },
);

const emit = defineEmits<{
  (event: 'select', conversationId: string): void;
  (event: 'create'): void;
}>();

function preview(conversation: ConversationSnapshot): string {
  const last = conversation.messages.at(-1);
  if (!last) return '还没有消息';
  const text = last.text.replace(/\s+/g, ' ').trim();
  return text.length > 34 ? `${text.slice(0, 34)}…` : text;
}

function unreadOf(conversationId: string): number {
  return props.unread[conversationId] ?? 0;
}
</script>

<template>
  <section class="sessions" :class="{ compact }">
    <header>
      <h2>会话</h2>
      <button v-if="canCreate" class="ww-btn ghost" type="button" title="新建会话并同步到两个界面" @click="emit('create')">
        ＋ 新会话
      </button>
    </header>

    <ul>
      <li v-for="conversation in conversations" :key="conversation.id">
        <button
          type="button"
          class="item"
          :class="{ active: conversation.id === currentId }"
          @click="emit('select', conversation.id)"
        >
          <span class="title">
            {{ conversation.title }}
            <span v-if="conversation.generating" class="ww-badge">生成中</span>
          </span>
          <span class="preview">{{ preview(conversation) }}</span>
          <span v-if="unreadOf(conversation.id) > 0" class="ww-unread">{{ unreadOf(conversation.id) }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sessions {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  border: 1px solid var(--dsh-line);
  border-radius: var(--dsh-radius-xl);
  background: var(--ww-panel);
  overflow: hidden;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 6px 16px;
}
h2 {
  margin: 0;
  font: var(--dsh-text-label);
  color: var(--dsh-ink-muted);
  letter-spacing: 0.06em;
}

ul {
  list-style: none;
  margin: 0;
  padding: 4px 8px 10px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.item {
  width: 100%;
  text-align: left;
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: 'title badge' 'preview badge';
  gap: 2px 8px;
  padding: 9px 10px;
  border-radius: var(--dsh-radius-lg);
  border: 1px solid transparent;
  transition: background var(--dsh-dur-fast) var(--dsh-ease), border-color var(--dsh-dur-fast) var(--dsh-ease);
}
.item:hover {
  background: var(--dsh-hover);
}
.item.active {
  background: color-mix(in srgb, var(--ww-violet) 16%, transparent);
  border-color: color-mix(in srgb, var(--ww-violet) 38%, transparent);
}

.title {
  grid-area: title;
  display: flex;
  align-items: center;
  gap: 6px;
  font: var(--dsh-text-label);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.preview {
  grid-area: preview;
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.item > .ww-unread {
  grid-area: badge;
  align-self: center;
}
.title .ww-badge {
  font-size: 10px;
  padding: 0 6px;
}
.sessions.compact {
  border: 0;
  background: transparent;
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
