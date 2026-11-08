<script setup lang="ts">
import { computed } from 'vue';
import ChatComposer from './ChatComposer.vue';
import ChatThread from './ChatThread.vue';
import CharacterStage from './CharacterStage.vue';
import type { AppViewState } from '../app/session.ts';

const props = defineProps<{ state: AppViewState }>();

const emit = defineEmits<{
  (event: 'open-workspace'): void;
  (event: 'open-capsule'): void;
  (event: 'hide-capsule'): void;
  (event: 'switch-conversation', conversationId: string): void;
  (event: 'create-conversation'): void;
  (event: 'draft', text: string): void;
  (event: 'send'): void;
}>();

const statusText = computed(() => {
  if (props.state.role === 'mirror') return props.state.connected ? '镜像窗口 · 共享主窗口会话' : '等待主窗口…';
  return props.state.generating ? '正在生成回复' : '在线 · 同一段对话';
});

function onSelect(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value) emit('switch-conversation', value);
}
</script>

<template>
  <div class="capsule-mode">
    <CharacterStage compact :speaking="state.generating" />

    <div class="dock">
      <aside v-if="state.capsuleVisible" class="capsule" aria-label="鲸鱼娘迷你聊天">
        <header class="head">
          <span class="avatar" aria-hidden="true">鲸</span>
          <div class="who">
            <strong>鲸鱼娘</strong>
            <span class="sub">
              <span v-if="state.generating" class="typing live"><i /><i /><i /></span>
              {{ statusText }}
            </span>
          </div>
          <div class="head-actions">
            <button class="ww-btn" type="button" @click="emit('open-workspace')">展开到工作区</button>
            <button class="ww-btn icon" type="button" title="收起胶囊" aria-label="收起胶囊" @click="emit('hide-capsule')">
              ⌄
            </button>
          </div>
        </header>

        <div class="switcher">
          <select :value="state.conversationId" aria-label="切换会话" @change="onSelect">
            <option v-for="conversation in state.conversations" :key="conversation.id" :value="conversation.id">
              {{ conversation.title }}
            </option>
          </select>
          <button
            v-if="state.role === 'authority'"
            class="ww-btn icon"
            type="button"
            title="新建会话（两个界面同步）"
            aria-label="新建会话"
            @click="emit('create-conversation')"
          >
            ＋
          </button>
          <span v-if="state.unread > 0" class="ww-unread" :title="`当前会话 ${state.unread} 条未读`">{{ state.unread }}</span>
        </div>

        <ChatThread
          compact
          :messages="state.current?.messages ?? []"
          :generating="state.generating"
          empty-text="这里就是工作区里那段对话，随便聊。"
        />

        <ChatComposer
          compact
          :model-value="state.draft"
          :busy="state.generating"
          :disabled="!state.connected"
          placeholder="和鲸鱼娘说点什么…"
          @update:model-value="emit('draft', $event)"
          @send="emit('send')"
        />

        <footer class="foot">
          <span class="ww-badge mock">MOCK · memory-mock</span>
          <span class="hint">工作区与胶囊共享同一会话</span>
        </footer>
      </aside>

      <button v-else class="launcher" type="button" @click="emit('open-capsule')">
        <span class="avatar" aria-hidden="true">鲸</span>
        <span class="launcher-text">
          <strong>鲸鱼娘 · 迷你聊天</strong>
          <small>{{ state.generating ? '正在生成，点开继续看' : state.unread > 0 ? `${state.unread} 条新消息` : '已收起，点这里继续' }}</small>
        </span>
        <span v-if="state.unread > 0" class="ww-unread">{{ state.unread }}</span>
        <span v-else class="chev">▲</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.capsule-mode {
  height: 100%;
  display: flex;
  min-height: 0;
  background: #0a0b11;
}

.dock {
  flex: 0 0 auto;
  width: 396px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 16px 20px;
  background: linear-gradient(180deg, #0c0d14, #08090e);
  border-left: 1px solid var(--dsh-line);
}

.capsule {
  height: min(640px, calc(100vh - 40px));
  min-height: 380px;
  display: flex;
  flex-direction: column;
  border-radius: 22px;
  border: 1px solid var(--ww-line);
  background: linear-gradient(180deg, color-mix(in srgb, #141726 88%, transparent), color-mix(in srgb, #0c0e16 92%, transparent));
  backdrop-filter: blur(18px);
  box-shadow: var(--ww-glow), var(--dsh-shadow-3);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 12px 10px 14px;
  border-bottom: 1px solid var(--dsh-line);
  background: linear-gradient(120deg, color-mix(in srgb, var(--ww-violet) 18%, transparent), transparent 70%);
}

.avatar {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font: var(--dsh-text-sm);
  color: #fff;
  background: linear-gradient(135deg, var(--ww-violet-deep), var(--ww-cyan));
  box-shadow: 0 0 0 2px rgb(255 255 255 / 0.1) inset;
}

.who {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.who strong {
  font: var(--dsh-text-label);
}
.sub {
  display: flex;
  align-items: center;
  gap: 5px;
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.typing.live {
  color: var(--ww-cyan);
}

.head-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.switcher {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsh-line);
}
select {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--dsh-radius-md);
  border: 1px solid var(--dsh-line);
  background: color-mix(in srgb, var(--dsh-surface-sunken) 70%, transparent);
  color: var(--dsh-ink);
  font: var(--dsh-text-sm);
}
select:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--ww-violet) 55%, transparent);
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px 10px;
  border-top: 1px solid transparent;
}
.foot .hint {
  font: var(--dsh-text-xs);
  color: color-mix(in srgb, var(--dsh-ink-muted) 76%, transparent);
  margin-left: auto;
}

.launcher {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--dsh-radius-full);
  border: 1px solid var(--ww-line);
  background: color-mix(in srgb, #151827 88%, transparent);
  backdrop-filter: blur(14px);
  box-shadow: var(--ww-glow);
  text-align: left;
  transition: transform var(--dsh-dur-fast) var(--dsh-ease), background var(--dsh-dur-fast) var(--dsh-ease);
}
.launcher:hover {
  transform: translateY(-2px);
  background: color-mix(in srgb, #1b2036 92%, transparent);
}
.launcher-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.launcher-text strong {
  font: var(--dsh-text-label);
}
.launcher-text small {
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}
.chev {
  color: var(--dsh-ink-muted);
  font-size: 12px;
}

@media (max-width: 1080px) {
  .dock {
    width: 352px;
  }
}

@media (max-width: 860px) {
  .capsule-mode {
    flex-direction: column-reverse;
  }
  .dock {
    width: 100%;
    padding: 8px 12px 12px;
  }
  .capsule {
    height: min(560px, calc(100vh - 24px));
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
