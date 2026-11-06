<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import CapsuleShell from './components/CapsuleShell.vue';
import WorkspaceShell from './components/WorkspaceShell.vue';
import { getWorkspaceApp, type AppViewState } from './app/session.ts';

const app = getWorkspaceApp();
const version = ref(0);
let unsubscribe: () => void = () => {};

onMounted(() => {
  unsubscribe = app.subscribe(() => {
    version.value += 1;
  });
});

onBeforeUnmount(() => {
  unsubscribe();
});

const state = computed<AppViewState>(() => {
  // 订阅计数只用于触发重算，真正的状态从 WorkspaceApp 读取
  void version.value;
  return app.viewState();
});

const conversationId = computed(() => state.value.conversationId);

function onDraft(text: string): void {
  app.updateDraft(text);
}

async function onSend(): Promise<void> {
  try {
    await app.send();
  } catch (error) {
    console.error('[whale-workspace] 发送失败', error);
  }
}

function onSwitch(id: string): void {
  app.switchConversation(id);
}

function onCreate(): void {
  app.createConversation();
  // 新建会话后把胶囊留在原处，两个界面读到的都是同一个新会话
}

function openMirror(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('role', 'mirror');
  window.open(url.toString(), 'whale-workspace-mirror', 'width=560,height=780');
}
</script>

<template>
  <div class="shell" :data-conversation="conversationId" :data-role="state.role" :data-view="state.view">
    <Transition name="swap" mode="out-in">
      <CapsuleShell
        v-if="state.view === 'capsule'"
        key="capsule"
        :state="state"
        @open-workspace="app.openWorkspace()"
        @open-capsule="app.openCapsule()"
        @hide-capsule="app.hideCapsule()"
        @switch-conversation="onSwitch"
        @create-conversation="onCreate"
        @draft="onDraft"
        @send="onSend"
      />
      <WorkspaceShell
        v-else
        key="workspace"
        :state="state"
        @open-capsule="app.openCapsule()"
        @switch-conversation="onSwitch"
        @create-conversation="onCreate"
        @draft="onDraft"
        @send="onSend"
        @open-mirror="openMirror"
      />
    </Transition>
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  height: 100%;
  overflow: hidden;
}

.swap-enter-active,
.swap-leave-active {
  transition: opacity 180ms var(--dsh-ease), transform 180ms var(--dsh-ease);
}
.swap-enter-from {
  opacity: 0;
  transform: scale(0.99) translateY(6px);
}
.swap-leave-to {
  opacity: 0;
  transform: scale(0.99);
}

@media (prefers-reduced-motion: reduce) {
  .swap-enter-active,
  .swap-leave-active {
    transition: none;
  }
}
</style>
