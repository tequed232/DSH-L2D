<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import M3Button from './M3Button.vue';

const props = defineProps<{ open: boolean; title: string }>();
const emit = defineEmits<{ close: [] }>();

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && props.open) emit('close');
};

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="scrim">
      <div v-if="props.open" class="scrim" @click="emit('close')" />
    </Transition>
    <Transition name="sheet">
      <section
        v-if="props.open"
        class="sheet"
        role="dialog"
        aria-modal="true"
        :aria-label="props.title"
      >
        <header class="head">
          <span class="grabber" />
          <h2>{{ props.title }}</h2>
          <M3Button variant="text" icon="close" icon-only size="sm" @click="emit('close')" />
        </header>
        <div class="body">
          <slot />
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet-scrim);
  background: var(--scrim);
  backdrop-filter: blur(2px);
}

.sheet {
  position: fixed;
  z-index: var(--z-sheet);
  left: 50%;
  bottom: 0;
  translate: -50% 0;
  width: min(640px, 100vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-container-low);
  border-radius: var(--shape-xl) var(--shape-xl) 0 0;
  box-shadow: var(--shadow-3);
  padding-bottom: env(safe-area-inset-bottom, 0);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 6px 24px;
  flex: none;
}

.grabber {
  position: absolute;
  top: 8px;
  left: 50%;
  translate: -50% 0;
  width: 32px;
  height: 4px;
  border-radius: var(--shape-full);
  background: var(--outline-variant);
}

.head h2 {
  flex: 1;
  margin: 0;
  font: var(--type-title-lg);
  color: var(--on-surface);
}

.body {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 24px 32px;
}

.scrim-enter-active,
.scrim-leave-active {
  transition: opacity var(--dur-medium) var(--ease-standard);
}
.scrim-enter-from,
.scrim-leave-to {
  opacity: 0;
}

.sheet-enter-active {
  transition:
    translate var(--dur-long) var(--ease-spring),
    opacity var(--dur-medium) var(--ease-standard);
}
.sheet-leave-active {
  transition:
    translate var(--dur-medium) var(--ease-standard),
    opacity var(--dur-short) var(--ease-standard);
}
.sheet-enter-from,
.sheet-leave-to {
  translate: -50% 24px;
  opacity: 0;
}
</style>
