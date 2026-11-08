<script setup lang="ts">
/**
 * 左栏「模型处理 / Agent 任务」占位面板。
 *
 * ⚠️ 占位：本仓没有模型处理与 Agent 任务的真实数据源，这里只还原信息层级与布局，
 * 所有步骤均为静态示例，不代表真实能力。
 */
const steps = [
  { label: '解析意图', detail: '等待接入宿主 Agent 事件流', state: 'idle' },
  { label: '调度动作', detail: 'l2d_set_expression / motion 占位', state: 'idle' },
  { label: '合成回复', detail: 'memory-mock 模板流式输出', state: 'active' },
];
</script>

<template>
  <section class="agent">
    <header>
      <h2>模型处理 · Agent 任务</h2>
      <span class="ww-badge">占位</span>
    </header>

    <ol>
      <li v-for="step in steps" :key="step.label" :class="step.state">
        <span class="dot" />
        <div>
          <strong>{{ step.label }}</strong>
          <small>{{ step.detail }}</small>
        </div>
      </li>
    </ol>

    <p class="note">该面板只验证双栏布局，尚未接入真实 Agent 任务通道。</p>
  </section>
</template>

<style scoped>
.agent {
  border: 1px solid var(--dsh-line);
  border-radius: var(--dsh-radius-xl);
  background: var(--ww-panel);
  padding: 12px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
h2 {
  margin: 0;
  font: var(--dsh-text-label);
  color: var(--dsh-ink-muted);
  letter-spacing: 0.06em;
}

ol {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
li {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 10px;
  border-radius: var(--dsh-radius-md);
  background: color-mix(in srgb, var(--dsh-surface-sunken) 55%, transparent);
  border: 1px solid var(--dsh-line);
}
li.active {
  border-color: color-mix(in srgb, var(--ww-violet) 42%, transparent);
  background: color-mix(in srgb, var(--ww-violet) 12%, transparent);
}
.dot {
  margin-top: 5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsh-line-strong);
}
li.active .dot {
  background: var(--ww-violet);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--ww-violet) 22%, transparent);
}
strong {
  display: block;
  font: var(--dsh-text-label);
}
small {
  color: var(--dsh-ink-muted);
  font: var(--dsh-text-xs);
}
.note {
  margin: 0;
  font: var(--dsh-text-xs);
  color: color-mix(in srgb, var(--dsh-ink-muted) 80%, transparent);
  border-top: 1px dashed var(--dsh-line);
  padding-top: 8px;
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
