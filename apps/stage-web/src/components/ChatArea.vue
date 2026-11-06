<script setup lang="ts">
/**
 * ChatArea —— 对话区
 *
 * 分层铁律：只呈现状态与分发交互。对话收发通道未接通（TODO），
 * 发送按钮禁用并明示，不伪造成功。
 */
import { ref } from 'vue';
import M3Icon from './M3Icon.vue';
import M3Button from './M3Button.vue';
import DshTextInput from './DshTextInput.vue';

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
}

// TODO(接口边界)：消息流应来自对话服务（如 overlay 的 AI 指令通道），
// 当前无持久化与传输层，列表初始为空，仅提供分层样式承载。
defineProps<{ messages: ChatMessage[] }>();
const emit = defineEmits<{ send: [text: string] }>();

const draft = ref('');
</script>

<template>
  <section class="chat">
    <div class="messages">
      <div v-if="messages.length === 0" class="empty">
        <M3Icon name="chat" :size="22" />
        <p>对话通道尚未接入（TODO）。此处将展示与 Companion 的对话记录。</p>
      </div>
      <template v-else>
        <div v-for="msg in messages" :key="msg.id" class="msg" :class="msg.role === 'user' ? 'is-user' : 'is-ai'">
          <span class="who"><M3Icon :name="msg.role === 'user' ? 'user' : 'sparkle'" :size="13" /></span>
          <p class="bubble">{{ msg.text }}</p>
        </div>
      </template>
    </div>

    <div class="composer">
      <DshTextInput
        v-model="draft"
        placeholder="输入消息…（通道未接入，仅样式预览）"
        @keydown.enter="emit('send', draft)"
      />
      <!-- TODO(接口边界)：发送走对话通道后启用；现禁用避免伪造送达 -->
      <M3Button
        variant="filled"
        icon="send"
        icon-only
        size="md"
        disabled
        title="TODO：对话通道未接入"
        @click="emit('send', draft)"
      />
    </div>
  </section>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-radius: var(--dsh-radius-xl);
  background: var(--dsh-surface);
  box-shadow: inset 0 0 0 1px var(--dsh-line);
  overflow: hidden;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--dsh-space-3);
  padding: var(--dsh-space-4);
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--dsh-space-2);
  color: var(--dsh-ink-muted);
}

.empty p {
  margin: 0;
  font: var(--dsh-text-sm);
  max-width: 26em;
  text-align: center;
}

/* 用户/AI 消息分层：用户靠右、accent-soft 底；AI 靠左、raised 底 */
.msg {
  display: flex;
  align-items: flex-end;
  gap: var(--dsh-space-2);
}

.msg.is-user {
  flex-direction: row-reverse;
}

.who {
  display: grid;
  place-items: center;
  width: var(--dsh-control-sm);
  height: var(--dsh-control-sm);
  flex: none;
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-surface-raised);
  color: var(--dsh-ink-muted);
}

.bubble {
  margin: 0;
  max-width: min(30em, 80%);
  padding: var(--dsh-space-2) var(--dsh-space-3);
  border-radius: var(--dsh-radius-lg);
  font: var(--dsh-text-md);
  background: var(--dsh-surface-raised);
  color: var(--dsh-ink);
  word-break: break-word;
}

.is-user .bubble {
  background: var(--dsh-accent-soft);
  color: var(--dsh-on-accent-soft);
  border-bottom-right-radius: var(--dsh-radius-sm);
}

.is-ai .bubble {
  border-bottom-left-radius: var(--dsh-radius-sm);
}

.composer {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-2);
  padding: var(--dsh-space-3) var(--dsh-space-4);
  border-top: 1px solid var(--dsh-line);
}
</style>
