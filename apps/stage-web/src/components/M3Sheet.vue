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
  z-index: var(--dsh-z-scrim);
  background: var(--dsh-scrim);
}

.sheet {
  position: fixed;
  z-index: var(--dsh-z-sheet);
  left: 50%;
  bottom: 0;
  translate: -50% 0;
  width: min(640px, 100vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--dsh-surface);
  border: 1px solid var(--dsh-line);
  border-bottom: none;
  border-radius: var(--dsh-radius-xl) var(--dsh-radius-xl) 0 0;
  box-shadow: var(--dsh-shadow-3);
  padding-bottom: env(safe-area-inset-bottom, 0);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-2);
  padding: var(--dsh-space-3) var(--dsh-space-3) var(--dsh-space-2) var(--dsh-space-5);
  flex: none;
}

.grabber {
  position: absolute;
  top: var(--dsh-space-2);
  left: 50%;
  translate: -50% 0;
  width: var(--dsh-space-6);
  height: var(--dsh-space-1);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-line-strong);
}

.head h2 {
  flex: 1;
  margin: 0;
  font: var(--dsh-text-xl);
  color: var(--dsh-ink);
}

.body {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--dsh-space-2) var(--dsh-space-5) var(--dsh-space-6);
}

.scrim-enter-active,
.scrim-leave-active {
  transition: opacity var(--dsh-dur) var(--dsh-ease);
}
.scrim-enter-from,
.scrim-leave-to {
  opacity: 0;
}

.sheet-enter-active,
.sheet-leave-active {
  transition:
    translate var(--dsh-dur-slow) var(--dsh-ease),
    opacity var(--dsh-dur) var(--dsh-ease);
}
.sheet-enter-from,
.sheet-leave-to {
  translate: -50% var(--dsh-space-4);
  opacity: 0;
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
