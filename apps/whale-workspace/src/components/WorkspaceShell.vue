<script setup lang="ts">
import AgentTaskPanel from './AgentTaskPanel.vue';
import ChatComposer from './ChatComposer.vue';
import ChatThread from './ChatThread.vue';
import ConversationList from './ConversationList.vue';
import type { AppViewState } from '../app/session.ts';

const props = defineProps<{ state: AppViewState }>();

const emit = defineEmits<{
  (event: 'open-capsule'): void;
  (event: 'open-mirror'): void;
  (event: 'switch-conversation', conversationId: string): void;
  (event: 'create-conversation'): void;
  (event: 'draft', text: string): void;
  (event: 'send'): void;
}>();

const messageCount = (): number => props.state.current?.messages.length ?? 0;
const conversationTitle = (): string => props.state.current?.title ?? '未命名会话';
</script>

<template>
  <div class="workspace">
    <header class="topbar">
      <div class="brand">
        <span class="logo">鲸</span>
        <div class="names">
          <strong>Whale Workspace</strong>
          <span>工作区</span>
        </div>
      </div>

      <div class="crumbs">
        <span class="title">{{ conversationTitle() }}</span>
        <span class="meta">{{ state.role === 'mirror' ? '镜像窗口' : `会话 ${state.conversationId}` }}</span>
      </div>

      <div class="actions">
        <span class="ww-badge mock">MOCK · memory-mock</span>
        <span v-if="state.role === 'mirror'" class="ww-badge">只读投影</span>
        <button
          v-if="state.role === 'authority'"
          class="ww-btn"
          type="button"
          title="在新窗口打开同一会话的镜像视图"
          @click="emit('open-mirror')"
        >
          镜像窗口
        </button>
        <button class="ww-btn primary" type="button" @click="emit('open-capsule')">迷你聊天</button>
      </div>
    </header>

    <div v-if="!state.connected" class="offline">
      正在等待主窗口的会话状态…（跨窗口通道 BroadcastChannel）
    </div>

    <main class="body">
      <aside class="rail">
        <AgentTaskPanel />
        <ConversationList
          :conversations="state.conversations"
          :current-id="state.conversationId"
          :unread="state.unreadByConversation"
          :can-create="state.role === 'authority'"
          @select="emit('switch-conversation', $event)"
          @create="emit('create-conversation')"
        />
      </aside>

      <section class="chat">
        <header class="chat-head">
          <div>
            <h1>{{ conversationTitle() }}</h1>
            <p>{{ messageCount() }} 条消息 · 与胶囊共享同一份会话状态</p>
          </div>
          <span v-if="state.generating" class="status">
            <span class="typing"><i /><i /><i /></span>
            正在生成
          </span>
        </header>

        <ChatThread
          :messages="state.current?.messages ?? []"
          :generating="state.generating"
          empty-text="还没有消息。试试输入一句，再把窗口收成胶囊。"
        />

        <ChatComposer
          :model-value="state.draft"
          :busy="state.generating"
          :disabled="!state.connected"
          @update:model-value="emit('draft', $event)"
          @send="emit('send')"
        />
      </section>
    </main>
  </div>
</template>

<style scoped>
.workspace {
  height: 100%;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(1100px 520px at 82% -12%, rgb(96 74 255 / 0.2), transparent 60%),
    radial-gradient(900px 460px at 4% 108%, rgb(60 160 255 / 0.12), transparent 60%),
    #0b0c12;
}

.topbar {
  height: 60px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 20px;
  border-bottom: 1px solid var(--dsh-line);
  background: color-mix(in srgb, #0b0c12 72%, transparent);
  backdrop-filter: blur(10px);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font: var(--dsh-text-label);
  color: #fff;
  background: linear-gradient(135deg, var(--ww-violet-deep), var(--ww-cyan));
  box-shadow: var(--dsh-shadow-1);
}
.names {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}
.names strong {
  font: var(--dsh-text-label);
  letter-spacing: 0.02em;
}
.names span {
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}

.crumbs {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.crumbs .title {
  font: var(--dsh-text-lg);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.crumbs .meta {
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
  white-space: nowrap;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.offline {
  margin: 8px 20px 0;
  padding: 8px 12px;
  border-radius: var(--dsh-radius-md);
  border: 1px solid color-mix(in srgb, var(--dsh-warn) 40%, transparent);
  background: color-mix(in srgb, var(--dsh-warn) 10%, transparent);
  color: var(--dsh-warn);
  font: var(--dsh-text-sm);
}

.body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 16px;
  padding: 16px 20px 20px;
}

.rail {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsh-line);
  border-radius: var(--dsh-radius-xl);
  background: var(--ww-panel);
  overflow: hidden;
  box-shadow: var(--dsh-shadow-2);
}

.chat-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px 12px;
  border-bottom: 1px solid var(--dsh-line);
  background: linear-gradient(180deg, color-mix(in srgb, var(--ww-violet) 10%, transparent), transparent);
}
.chat-head h1 {
  margin: 0 0 2px;
  font: var(--dsh-text-xl);
}
.chat-head p {
  margin: 0;
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: var(--dsh-text-xs);
  color: var(--ww-cyan);
  border: 1px solid color-mix(in srgb, var(--ww-cyan) 34%, transparent);
  border-radius: var(--dsh-radius-full);
  padding: 4px 10px;
  background: color-mix(in srgb, var(--ww-cyan) 10%, transparent);
}

@media (max-width: 980px) {
  .body {
    grid-template-columns: 280px minmax(0, 1fr);
  }
  .crumbs .meta {
    display: none;
  }
}
</style>
