/**
 * Cubism 5-r.5 的着色器源码（构建期内联）
 *
 * 为什么要内联：
 *   该版本把 shader 从「内嵌字符串」改成了运行时 fetch 外部文件，
 *   默认路径是 CubismShader_WebGL._defaultShaderPath = '../../Framework/Shaders/WebGL/'。
 *   一旦打包成单文件（或部署到任意静态根），这个相对路径必然 404，
 *   而 loadShader 的 catch 只 console.error 不抛异常，于是：
 *     - 模型解析成功、参数/网格数量都对
 *     - 每帧循环也在跑
 *     - 但 _shaderSets 里的 program 全是 0
 *     - 每帧刷 "Shader program is not initialized."
 *     - 画面全透明
 *   把源码直接注入实例可以彻底避免这类「看似正常但一片空白」的失败。
 *
 * 键名必须与 cubismshader_webgl.ts 里 shaderFiles 的 prop 完全一致。
 */
import vertShaderSrc from './vertshadersrc.vert?raw';
import vertShaderSrcMasked from './vertshadersrcmasked.vert?raw';
import vertShaderSrcSetupMask from './vertshadersrcsetupmask.vert?raw';
import vertShaderSrcCopy from './vertshadersrccopy.vert?raw';
import vertShaderSrcBlend from './vertshadersrcblend.vert?raw';

import fragShaderSrcSetupMask from './fragshadersrcsetupmask.frag?raw';
import fragShaderSrcPremultipliedAlpha from './fragshadersrcpremultipliedalpha.frag?raw';
import fragShaderSrcMaskPremultipliedAlpha from './fragshadersrcmaskpremultipliedalpha.frag?raw';
import fragShaderSrcMaskInvertedPremultipliedAlpha from './fragshadersrcmaskinvertedpremultipliedalpha.frag?raw';
import fragShaderSrcCopy from './fragshadersrccopy.frag?raw';
import fragShaderSrcColorBlend from './fragshadersrccolorblend.frag?raw';
import fragShaderSrcAlphaBlend from './fragshadersrcalphablend.frag?raw';
import fragShaderSrcBlend from './fragshadersrcpremultipliedalphablend.frag?raw';

export const SHADER_SOURCES = {
  _vertShaderSrc: vertShaderSrc,
  _vertShaderSrcMasked: vertShaderSrcMasked,
  _vertShaderSrcSetupMask: vertShaderSrcSetupMask,
  _vertShaderSrcCopy: vertShaderSrcCopy,
  _vertShaderSrcBlend: vertShaderSrcBlend,

  _fragShaderSrcSetupMask: fragShaderSrcSetupMask,
  _fragShaderSrcPremultipliedAlpha: fragShaderSrcPremultipliedAlpha,
  _fragShaderSrcMaskPremultipliedAlpha: fragShaderSrcMaskPremultipliedAlpha,
  _fragShaderSrcMaskInvertedPremultipliedAlpha: fragShaderSrcMaskInvertedPremultipliedAlpha,
  _fragShaderSrcCopy: fragShaderSrcCopy,
  _fragShaderSrcColorBlend: fragShaderSrcColorBlend,
  _fragShaderSrcAlphaBlend: fragShaderSrcAlphaBlend,
  _fragShaderSrcBlend: fragShaderSrcBlend,
} as const;
