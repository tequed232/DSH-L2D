<script setup lang="ts">
/**
 * PluginCenterView —— 插件/能力中心
 *
 * 数据源：tools/w3-registry/registry.json（仓内现有真实注册表，构建期导入），
 * 并在挂载时探测插件服务 /dsh-l2d/status.json 的可达性。
 * 启停/调用协议（/dsh-l2d/ai/call）未在本视图接通前，相关按钮禁用并标 TODO；
 * 通道不可达时如实展示失败，不伪造成功。
 */
import { computed, onMounted, ref } from 'vue';
import M3Icon from './M3Icon.vue';
import registry from '../../../../tools/w3-registry/registry.json';

interface RegistryEntry {
  id: string;
  kind: string;
  label: string;
  slot?: string;
  api?: string;
  assets?: Array<{ durationMs?: number }>;
}

const KIND_LABEL: Record<string, string> = {
  'motion-pair': '动作组',
  expression: '表情',
  pose: '姿态',
  param: '参数通道',
};

const entries = computed(() => (registry.entries ?? []) as RegistryEntry[]);
const modelInfo = computed(() => registry.model);

const kindOptions = computed(() => {
  const kinds = [...new Set(entries.value.map((e) => e.kind))];
  return [
    { value: 'all', label: '全部类型' },
    ...kinds.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k })),
  ];
});

const kindFilter = ref('all');
const filtered = computed(() =>
  kindFilter.value === 'all' ? entries.value : entries.value.filter((e) => e.kind === kindFilter.value),
);

const pluginReachable = ref<boolean | null>(null);
const probeError = ref('');
onMounted(async () => {
  try {
    const res = await fetch('/dsh-l2d/status.json', { cache: 'no-store' });
    pluginReachable.value = res.ok;
    if (!res.ok) probeError.value = `HTTP ${res.status}`;
  } catch (e) {
    pluginReachable.value = false;
    probeError.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <section class="center">
    <header class="head">
      <div>
        <h2>Plugin Center</h2>
        <p class="sub">
          模型 {{ modelInfo?.id || '—' }} · 能力 {{ entries.length }} 项 · 表情 {{ modelInfo?.expressionCount ?? '—' }} ·
          动作组 {{ modelInfo?.motionGroupCount ?? '—' }}
        </p>
      </div>
      <span class="reach" :class="{ ok: pluginReachable, bad: pluginReachable === false }">
        <i />{{ pluginReachable === null ? '探测中' : pluginReachable ? '运行时可达' : '运行时不可达' }}
      </span>
    </header>

    <p v-if="pluginReachable === false" class="alert">
      插件服务通道（/dsh-l2d/）当前不可达（{{ probeError }}）。以下卡片来自仓内注册表静态数据；
      调用/启停在通道接通前保持禁用（TODO），不会伪造成功。
    </p>

    <div class="filter">
      <select v-model="kindFilter" class="filter-select" aria-label="按类型筛选">
        <option v-for="opt in kindOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </div>

    <div class="cards">
      <article v-for="entry in filtered" :key="entry.id" class="card">
        <div class="card-icon"><M3Icon :name="entry.kind === 'expression' ? 'sparkle' : 'play'" :size="16" /></div>
        <div class="card-body">
          <div class="card-title">{{ entry.label }}</div>
          <div class="card-meta">
            <span class="chip">{{ KIND_LABEL[entry.kind] ?? entry.kind }}</span>
            <span v-if="entry.assets?.[0]?.durationMs" class="dim">{{ entry.assets[0].durationMs }}ms</span>
          </div>
        </div>
        <!-- TODO(接口边界)：启停/调用协议（POST /dsh-l2d/ai/call）的 UI 接线未完成 -->
        <button class="card-act" type="button" disabled title="TODO：调用协议接线未完成">调用</button>
      </article>
      <p v-if="filtered.length === 0" class="empty">该类型暂无注册条目。</p>
    </div>
  </section>
</template>

<style scoped>
.center {
  display: flex;
  flex-direction: column;
  gap: var(--dsh-space-4);
  min-height: 0;
  overflow-y: auto;
  padding: var(--dsh-space-4);
  border-radius: var(--dsh-radius-xl);
  background: var(--dsh-surface);
  box-shadow: inset 0 0 0 1px var(--dsh-line);
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--dsh-space-4);
}

.head h2 {
  margin: 0;
  font: var(--dsh-text-xl);
  color: var(--dsh-ink);
}

.sub {
  margin: var(--dsh-space-1) 0 0;
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}

.reach {
  display: inline-flex;
  align-items: center;
  gap: var(--dsh-space-2);
  height: var(--dsh-control-sm);
  padding: 0 var(--dsh-space-3);
  flex: none;
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-surface-raised);
  color: var(--dsh-ink-muted);
  font: var(--dsh-text-xs);
  font-weight: 500;
}

.reach i {
  width: var(--dsh-space-2);
  height: var(--dsh-space-2);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-ink-muted);
}

.reach.ok i {
  background: var(--dsh-ok);
}

.reach.bad i {
  background: var(--dsh-danger);
}

.alert {
  margin: 0;
  padding: var(--dsh-space-3) var(--dsh-space-4);
  border-radius: var(--dsh-radius-lg);
  background: var(--dsh-surface-raised);
  color: var(--dsh-warn);
  font: var(--dsh-text-xs);
}

.filter-select {
  height: var(--dsh-control-sm);
  padding: 0 var(--dsh-space-3);
  border-radius: var(--dsh-radius-md);
  border: 1px solid var(--dsh-line);
  background: var(--dsh-surface-sunken);
  color: var(--dsh-ink);
  font: var(--dsh-text-sm);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--dsh-space-3);
}

.card {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-3);
  padding: var(--dsh-space-3) var(--dsh-space-4);
  border-radius: var(--dsh-radius-lg);
  background: var(--dsh-surface-raised);
}

.card-icon {
  display: grid;
  place-items: center;
  width: var(--dsh-control-sm);
  height: var(--dsh-control-sm);
  flex: none;
  border-radius: var(--dsh-radius-md);
  background: var(--dsh-accent-soft);
  color: var(--dsh-on-accent-soft);
}

.card-body {
  flex: 1;
  min-width: 0;
}

.card-title {
  font: var(--dsh-text-label);
  color: var(--dsh-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: var(--dsh-space-2);
  margin-top: var(--dsh-space-1);
}

.chip {
  padding: 0 var(--dsh-space-2);
  border-radius: var(--dsh-radius-full);
  background: var(--dsh-surface-sunken);
  color: var(--dsh-ink-muted);
  font: var(--dsh-text-xs);
}

.dim {
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}

.card-act {
  flex: none;
  height: var(--dsh-control-sm);
  padding: 0 var(--dsh-space-3);
  border-radius: var(--dsh-radius-md);
  border: 1px solid var(--dsh-line);
  background: transparent;
  color: var(--dsh-ink);
  font: var(--dsh-text-xs);
  cursor: pointer;
}

.card-act:disabled {
  opacity: var(--dsh-disabled-opacity);
  cursor: not-allowed;
}

.empty {
  margin: 0;
  font: var(--dsh-text-sm);
  color: var(--dsh-ink-muted);
}
</style>
