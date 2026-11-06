<script setup lang="ts">
/**
 * 角色舞台。
 *
 * ⚠️ 本应用只做工作区/胶囊的交互壳，不包含 Live2D 渲染管线（renderer 属其它代理域），
 * 这里用内置 SVG 作为「鲸鱼娘」站位，方便在没有模型资源时也能验证布局与切换。
 */
defineProps<{
  compact?: boolean;
  speaking?: boolean;
}>();

const bubbleStyle = (index: number): Record<string, string> => ({ '--i': String(index) });
</script>

<template>
  <div class="stage" :class="{ compact }">
    <div class="halo" />
    <div class="bubbles">
      <span v-for="i in 7" :key="i" class="bubble" :style="bubbleStyle(i)" />
    </div>

    <svg class="whale-girl" viewBox="0 0 360 480" role="img" aria-label="鲸鱼娘站位立绘（占位）">
      <defs>
        <linearGradient id="wwHair" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#9c8dff" />
          <stop offset="0.55" stop-color="#6f5cff" />
          <stop offset="1" stop-color="#382c9c" />
        </linearGradient>
        <linearGradient id="wwHairBack" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#7d6cff" />
          <stop offset="1" stop-color="#2b2270" />
        </linearGradient>
        <linearGradient id="wwSkin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffefe6" />
          <stop offset="1" stop-color="#f6cfc0" />
        </linearGradient>
        <linearGradient id="wwHoodie" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#65d2ff" />
          <stop offset="0.6" stop-color="#5a8dff" />
          <stop offset="1" stop-color="#4b46d6" />
        </linearGradient>
        <radialGradient id="wwGlow" cx="0.5" cy="0.45" r="0.6">
          <stop offset="0" stop-color="#8b7dff" stop-opacity="0.55" />
          <stop offset="1" stop-color="#8b7dff" stop-opacity="0" />
        </radialGradient>
      </defs>

      <circle cx="180" cy="220" r="170" fill="url(#wwGlow)" />

      <!-- 鲸尾 -->
      <g class="tail">
        <path
          d="M254 392c46 6 74-16 88-46 6 26-4 52-26 68 26 2 44 14 56 34-34 8-64 2-88-16-18-14-30-24-30-40Z"
          fill="url(#wwHairBack)"
          opacity="0.95"
        />
        <path d="M256 396c22 8 40 10 58 6" stroke="#a99bff" stroke-opacity="0.4" stroke-width="3" fill="none" />
      </g>

      <!-- 长发（后） -->
      <path
        d="M180 74c56 0 96 36 100 92 2 32-8 58-8 92 0 30 12 54 12 84 0 20-12 36-34 44-12-24-18-50-18-78 0-36 8-62 8-92 0-44-26-70-60-70s-60 26-60 70c0 30 8 56 8 92 0 28-6 54-18 78-22-8-34-24-34-44 0-30 12-54 12-84 0-34-10-60-8-92 4-56 44-92 100-92Z"
        fill="url(#wwHairBack)"
      />

      <!-- 身体 / 连帽衫 -->
      <path
        d="M180 276c46 0 78 26 86 62 6 26 10 58 10 86H84c0-28 4-60 10-86 8-36 40-62 86-62Z"
        fill="url(#wwHoodie)"
      />
      <path
        d="M180 276c18 0 34 4 46 12-8 22-24 36-46 36s-38-14-46-36c12-8 28-12 46-12Z"
        fill="#0f1730"
        opacity="0.22"
      />
      <path d="M148 342h64" stroke="#dff3ff" stroke-opacity="0.5" stroke-width="4" stroke-linecap="round" />

      <!-- 手臂 -->
      <path d="M104 316c-16 14-26 36-28 58-1 12 7 20 18 20 11 0 17-8 18-20l2-34" fill="url(#wwHoodie)" />
      <path d="M256 316c16 14 26 36 28 58 1 12-7 20-18 20-11 0-17-8-18-20l-2-34" fill="url(#wwHoodie)" />
      <circle cx="88" cy="396" r="13" fill="url(#wwSkin)" />
      <circle cx="272" cy="396" r="13" fill="url(#wwSkin)" />

      <!-- 鳍耳 -->
      <path d="M92 176c-24-10-36 4-38 26-2 20 10 34 30 36Z" fill="url(#wwHair)" />
      <path d="M268 176c24-10 36 4 38 26 2 20-10 34-30 36Z" fill="url(#wwHair)" />

      <!-- 脸 -->
      <ellipse cx="180" cy="196" rx="76" ry="80" fill="url(#wwSkin)" />
      <path d="M104 172c10-46 42-70 76-70s66 24 76 70c-24-26-46-38-76-38s-52 12-76 38Z" fill="url(#wwHair)" />
      <path d="M126 132c14-30 32-44 54-44s40 14 54 44c-18-12-36-18-54-18s-36 6-54 18Z" fill="url(#wwHair)" />

      <!-- 眼睛 -->
      <g class="eyes" :class="{ blink: !speaking }">
        <ellipse cx="148" cy="204" rx="15" ry="18" fill="#1b1636" />
        <ellipse cx="212" cy="204" rx="15" ry="18" fill="#1b1636" />
        <circle cx="153" cy="198" r="5.5" fill="#8fe8ff" />
        <circle cx="217" cy="198" r="5.5" fill="#8fe8ff" />
        <circle cx="144" cy="212" r="3" fill="#ffffff" opacity="0.8" />
        <circle cx="208" cy="212" r="3" fill="#ffffff" opacity="0.8" />
      </g>
      <path d="M130 176c8-6 18-8 28-5" stroke="#3b2f7a" stroke-width="4" stroke-linecap="round" fill="none" />
      <path d="M230 176c-8-6-18-8-28-5" stroke="#3b2f7a" stroke-width="4" stroke-linecap="round" fill="none" />

      <!-- 腮红 / 嘴 -->
      <ellipse cx="130" cy="228" rx="14" ry="7" fill="#ff9bb0" opacity="0.45" />
      <ellipse cx="230" cy="228" rx="14" ry="7" fill="#ff9bb0" opacity="0.45" />
      <path d="M170 236c6 8 14 8 20 0" stroke="#b4566e" stroke-width="4" stroke-linecap="round" fill="none" />

      <!-- 发饰 -->
      <g class="fin">
        <path d="M262 128c18-16 34-18 46-8-10 14-24 22-42 24Z" fill="#6fd6ff" />
        <circle cx="270" cy="132" r="5" fill="#e9f9ff" />
      </g>
    </svg>

    <div class="name-plate">
      <strong>鲸鱼娘</strong>
      <span>{{ speaking ? '正在回复…' : '在角色旁等你' }}</span>
    </div>

    <div class="stage-caption">
      <strong>DSH 宿主页 · 角色浮层示意</strong>
      <span>角色站位为内置 SVG 占位；Live2D 渲染管线不在本应用内</span>
    </div>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background:
    radial-gradient(900px 620px at 78% 12%, rgb(104 82 255 / 0.22), transparent 62%),
    radial-gradient(700px 520px at 12% 92%, rgb(72 178 255 / 0.14), transparent 60%),
    #0a0b11;
}

.stage::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: linear-gradient(rgb(255 255 255 / 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgb(255 255 255 / 0.03) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(circle at 60% 40%, #000 20%, transparent 78%);
  pointer-events: none;
}

.halo {
  position: absolute;
  right: 4%;
  bottom: -12%;
  width: 620px;
  height: 620px;
  border-radius: 50%;
  background: radial-gradient(circle, rgb(139 125 255 / 0.24), transparent 62%);
  filter: blur(6px);
}

.whale-girl {
  position: absolute;
  right: 5%;
  bottom: 0;
  height: min(86%, 560px);
  filter: drop-shadow(0 30px 60px rgb(9 6 35 / 0.6));
  animation: float 6.5s ease-in-out infinite;
}

.stage.compact .whale-girl {
  height: min(88%, 480px);
  right: 2%;
}

.tail {
  transform-origin: 250px 380px;
  animation: tail-sway 5.5s ease-in-out infinite;
}

.eyes.blink {
  animation: blink 6.4s infinite;
  transform-origin: 180px 204px;
}

.fin {
  animation: fin-sway 4.6s ease-in-out infinite;
  transform-origin: 262px 128px;
}

.bubbles {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.bubble {
  position: absolute;
  bottom: 18%;
  left: calc(6% + var(--i) * 5%);
  width: calc(6px + var(--i) * 1.4px);
  height: calc(6px + var(--i) * 1.4px);
  border-radius: 50%;
  border: 1px solid rgb(160 210 255 / 0.5);
  background: rgb(120 190 255 / 0.12);
  animation: rise calc(7s + var(--i) * 0.9s) linear infinite;
  animation-delay: calc(var(--i) * -0.7s);
  opacity: 0;
}

.name-plate {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 20px;
  border-radius: var(--dsh-radius-full);
  background: rgb(12 14 22 / 0.6);
  border: 1px solid var(--ww-line);
  backdrop-filter: blur(8px);
}
.name-plate strong {
  font: var(--dsh-text-label);
  letter-spacing: 0.08em;
}
.name-plate span {
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
}

.stage-caption {
  position: absolute;
  top: 22px;
  left: 26px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 320px;
  padding-left: 12px;
  border-left: 2px solid color-mix(in srgb, var(--ww-violet) 55%, transparent);
}
.stage-caption strong {
  font: var(--dsh-text-label);
  color: color-mix(in srgb, var(--dsh-ink) 88%, transparent);
}
.stage-caption span {
  font: var(--dsh-text-xs);
  color: var(--dsh-ink-muted);
  line-height: 1.5;
}

@keyframes float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-10px);
  }
}
@keyframes tail-sway {
  0%,
  100% {
    transform: rotate(-3deg);
  }
  50% {
    transform: rotate(5deg);
  }
}
@keyframes fin-sway {
  0%,
  100% {
    transform: rotate(-4deg);
  }
  50% {
    transform: rotate(6deg);
  }
}
@keyframes blink {
  0%,
  92%,
  100% {
    transform: scaleY(1);
  }
  95% {
    transform: scaleY(0.08);
  }
}
@keyframes rise {
  0% {
    transform: translateY(0) scale(0.9);
    opacity: 0;
  }
  15% {
    opacity: 0.8;
  }
  100% {
    transform: translateY(-360px) scale(1.15);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .whale-girl,
  .tail,
  .fin,
  .eyes.blink,
  .bubble {
    animation: none;
  }
}
</style>
