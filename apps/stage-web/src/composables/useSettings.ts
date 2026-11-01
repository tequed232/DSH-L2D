import { reactive, watch } from 'vue';

export type ThemeMode = 'dark' | 'light';
export type ContextState = 'idle' | 'conversation' | 'work' | 'away';

export interface Settings {
  theme: ThemeMode;
  /** 模型显示缩放 */
  scale: number;
  /** 待机微动作强度 0~1 */
  idleIntensity: number;
  /** 打字/切窗等操作反应 */
  typingReaction: boolean;
  /** 全屏应用时自动降帧 */
  fullscreenDegrade: boolean;
  /** 口型同步 */
  lipSync: boolean;
  lipSyncGain: number;
  /** 摄像头面捕 */
  cameraTracking: boolean;
  /** 全局键鼠感知（隐私敏感） */
  globalInput: boolean;
  /** 仅用于 UI 预览当前情境，不影响真实感知 */
  contextPreview: ContextState;
}

const STORAGE_KEY = 'dsh-l2d.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  scale: 1,
  idleIntensity: 0.6,
  typingReaction: true,
  fullscreenDegrade: true,
  lipSync: true,
  lipSyncGain: 1,
  cameraTracking: false,
  globalInput: false,
  contextPreview: 'idle',
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const settings = reactive<Settings>(load());

watch(
  settings,
  (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      /* 隐私模式下 localStorage 不可写，忽略 */
    }
    document.documentElement.dataset.theme = value.theme;
  },
  { deep: true, immediate: true },
);

export function useSettings() {
  return { settings };
}

export function resetSettings() {
  Object.assign(settings, DEFAULT_SETTINGS);
}
