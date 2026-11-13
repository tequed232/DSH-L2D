/**
 * 动作程序运行时参数槽（用户设计 2026-11-13，ACTION-PROGRAM-SPEC-DRAFT.md §2）。
 *
 * 规则：
 *   - 槽类型仅限 number / enum / bool，不允许表达式或代码，保证执行可复现；
 *   - 加载时校验槽定义（defineSlots），调用时按 min/max 钳制，缺省用 default；
 *   - 槽值来源：调用参数（args）或命名输入通道；未提供的槽用 default；
 *   - 槽只负责"取值"，最终参数仍要过参数所有权与模型能力检查——槽不能绕过安全层。
 */

/**
 * 加载期校验槽定义。返回标准化后的槽表（引用同输入）；非法即抛错。
 * @param {Record<string, {type:'number',min:number,max:number,default:number}
 *   | {type:'enum',values:string[],default:string}
 *   | {type:'bool',default:boolean}>} slots
 */
export function defineSlots(slots) {
  if (slots === undefined || slots === null) return {};
  if (typeof slots !== 'object' || Array.isArray(slots)) {
    throw new Error('defineSlots: slots 必须是对象');
  }
  for (const [name, def] of Object.entries(slots)) {
    if (!def || typeof def !== 'object') throw new Error(`defineSlots: 槽 ${name} 定义缺失`);
    if (def.type === 'number') {
      if (typeof def.min !== 'number' || typeof def.max !== 'number' || def.min > def.max) {
        throw new Error(`defineSlots: 槽 ${name}（number）需要合法的 min<=max`);
      }
      if (typeof def.default !== 'number' || Number.isNaN(def.default)) {
        throw new Error(`defineSlots: 槽 ${name}（number）default 必须是数字`);
      }
    } else if (def.type === 'enum') {
      if (!Array.isArray(def.values) || def.values.length === 0
        || !def.values.every((v) => typeof v === 'string')) {
        throw new Error(`defineSlots: 槽 ${name}（enum）values 必须是非空字符串数组`);
      }
      if (!def.values.includes(def.default)) {
        throw new Error(`defineSlots: 槽 ${name}（enum）default 必须在 values 内`);
      }
    } else if (def.type === 'bool') {
      if (typeof def.default !== 'boolean') {
        throw new Error(`defineSlots: 槽 ${name}（bool）default 必须是布尔`);
      }
    } else {
      throw new Error(`defineSlots: 槽 ${name} 类型非法：${String(def.type)}（仅 number/enum/bool）`);
    }
  }
  return slots;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * 解析步骤参数：把 `{"$slot": name}` 替换为实际值，其余值原样返回。
 * @param {Record<string, unknown>} params 步骤参数（可能含 $slot 引用）
 * @param {Record<string, object>} slots 已通过 defineSlots 的槽表
 * @param {Record<string, unknown>} args 调用方传入的槽值
 * @returns {{ok: true, params: Record<string, unknown>}
 *   | {ok: false, reason: string, message: string}}
 */
export function resolveParams(params, slots, args) {
  const src = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const argSrc = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, '$slot')) {
      const name = value.$slot;
      const def = slots ? slots[name] : undefined;
      if (!def) {
        return { ok: false, reason: 'unknown-slot', message: `步骤参数 ${key} 引用了未声明的槽 "${name}"` };
      }
      const provided = argSrc[name];
      if (def.type === 'number') {
        const n = typeof provided === 'number' && Number.isFinite(provided) ? provided : def.default;
        out[key] = clamp(n, def.min, def.max);
      } else if (def.type === 'enum') {
        out[key] = def.values.includes(provided) ? provided : def.default;
      } else {
        out[key] = typeof provided === 'boolean' ? provided : def.default;
      }
    } else {
      out[key] = value; // 常量原样透传
    }
  }
  return { ok: true, params: out };
}
