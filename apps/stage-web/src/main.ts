import { createApp } from 'vue';
import App from './App.vue';
// ui-tokens 副本（apps 内自包含）：源文件 packages/dsh-l2d-plugin/assets/ui-tokens.css。
// 副本原因：跨 Vite root 导入在 dev/preview 下会被 fs 策略拒绝导致整页空白（2026-11-05 审计 A1）。
// 改动源文件后需同步本副本。
import './styles/ui-tokens.css';
import './styles/base.css';

createApp(App).mount('#app');
