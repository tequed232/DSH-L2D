/**
 * 饰品分组读取与薄适配层。
 *
 * 数据源：docs/nodegraph/models/<modelId>/body-regions.json 的 `accessories` 字段
 *（正式表，见 BODY-REGIONS.md「饰品槽位」）。不在前端硬编码分组。
 *
 * 字段（accessories）：
 * - note, slots[], uncertain[], params[], physicsOutputs[]
 * - slot: { id, label, exclusive, canCombineWithOtherSlots, params?, items[], note? }
 * - item: { id, label, kind: "expression"|"param", ref, on, off, writesParam?, blend?, paramHome?, note? }
 *   kind=expression 时 ref 是表情名、writesParam 是写入参数；
 *   kind=param 时 ref 是参数 id。
 *
 * 菜单规则：只展示 items.length > 0 的槽；兽耳/翅膀（空槽）、uncertain、体型不进菜单。
 * exclusive 缺省为 false：每件独立开关，戴新的不摘旧的。若将来表里 exclusive=true，
 * 开新件时才把同槽其它件写成 off。
 *
 * 替换点（bridge PR）：UI 只调用 planAccessoryToggle / applyAccessoryToggle / isAccessoryOn。
 * 后端大手子在 bridge 加上饰品层后，把 applyAccessoryToggle 换成 bridge 调用即可；
 * 规划结果仍是「这件开/关应写入的参数 on/off」，不要全身重置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL_IDS_DIR, isSafeModelId } from './nodegraph-schema.mjs';

const CATALOG_FILE = path.join(DEFAULT_MODEL_IDS_DIR, '..', 'live2d-catalog.json');

let paramDefaultCache = null;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function paramDefaultsFromCatalog(file) {
  const src = file || CATALOG_FILE;
  if (paramDefaultCache && paramDefaultCache.file === src) return paramDefaultCache.map;
  const data = readJson(src);
  const map = {};
  const list = data && Array.isArray(data.parameters) ? data.parameters : [];
  for (const row of list) {
    if (row && typeof row.id === 'string' && Number.isFinite(Number(row.default))) {
      map[row.id] = Number(row.default);
    }
  }
  paramDefaultCache = { file: src, map };
  return map;
}

export function itemParam(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.writesParam === 'string' && item.writesParam) return item.writesParam;
  if (item.kind === 'param' && typeof item.ref === 'string') return item.ref;
  return '';
}

export function isAccessoryOn(value, item) {
  if (!item) return false;
  const current = Number(value);
  const on = Number(item.on);
  const off = Number(item.off);
  if (!Number.isFinite(current) || !Number.isFinite(on) || !Number.isFinite(off)) return false;
  return Math.abs(current - on) < Math.abs(current - off);
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const kind = raw.kind === 'expression' || raw.kind === 'param' ? raw.kind : (raw.writesParam ? 'expression' : 'param');
  const item = {
    id,
    label: typeof raw.label === 'string' ? raw.label : id,
    kind,
    ref: typeof raw.ref === 'string' ? raw.ref : '',
    on: Number(raw.on),
    off: Number(raw.off),
  };
  if (!Number.isFinite(item.on)) item.on = 1;
  if (!Number.isFinite(item.off)) item.off = 0;
  if (typeof raw.writesParam === 'string' && raw.writesParam) item.writesParam = raw.writesParam;
  if (typeof raw.blend === 'string') item.blend = raw.blend;
  if (typeof raw.paramHome === 'string') item.paramHome = raw.paramHome;
  if (typeof raw.note === 'string') item.note = raw.note;
  return itemParam(item) ? item : null;
}

function normalizeSlot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter(Boolean) : [];
  return {
    id,
    label: typeof raw.label === 'string' ? raw.label : id,
    exclusive: raw.exclusive === true, // 缺省不互斥
    canCombineWithOtherSlots: raw.canCombineWithOtherSlots !== false,
    items,
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
  };
}

export function normalizeAccessories(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const slots = Array.isArray(src.slots) ? src.slots.map(normalizeSlot).filter(Boolean) : [];
  return {
    note: typeof src.note === 'string' ? src.note : '',
    slots,
    uncertain: Array.isArray(src.uncertain) ? src.uncertain : [],
  };
}

/** 菜单/设置页用：丢掉空槽（兽耳、翅膀）和 uncertain。 */
export function menuSlots(accessories) {
  const slots = accessories && Array.isArray(accessories.slots) ? accessories.slots : [];
  return slots.filter((slot) => slot && Array.isArray(slot.items) && slot.items.length > 0);
}

/**
 * 规划一件饰品的开/关写入。UI 与将来的 bridge 都走这里。
 * exclusive 槽在「打开」时才把同槽其它件写成 off；默认不互斥，只写这一件。
 */
export function planAccessoryToggle(slot, item, wantOn) {
  if (!item) return { values: {}, itemId: '', slotId: slot && slot.id ? slot.id : '', on: !!wantOn };
  const values = {};
  const param = itemParam(item);
  if (param) values[param] = wantOn ? item.on : item.off;
  if (wantOn && slot && slot.exclusive === true && Array.isArray(slot.items)) {
    for (const other of slot.items) {
      if (!other || other.id === item.id) continue;
      const otherParam = itemParam(other);
      if (otherParam && values[otherParam] === undefined) values[otherParam] = other.off;
    }
  }
  return {
    values,
    itemId: item.id,
    slotId: slot && slot.id ? slot.id : '',
    kind: item.kind,
    ref: item.ref,
    on: !!wantOn,
  };
}

export function resolveAccessoriesFile(modelId, modelsDir) {
  if (!isSafeModelId(modelId)) return null;
  return path.join(modelsDir || DEFAULT_MODEL_IDS_DIR, modelId, 'body-regions.json');
}

/**
 * @returns {{ modelId: string, source: 'body-regions'|'none', file: string|null, accessories: object, menuSlots: object[], warning?: string }}
 */
export function loadAccessoriesForModel(modelId, options = {}) {
  const id = String(modelId || '');
  if (!id || !isSafeModelId(id)) {
    return { modelId: id, source: 'none', file: null, accessories: normalizeAccessories(null), menuSlots: [], warning: 'invalid-model-id' };
  }
  const file = resolveAccessoriesFile(id, options.modelsDir);
  const data = file ? readJson(file) : null;
  const raw = data && data.accessories ? data.accessories : null;
  if (!raw) {
    return {
      modelId: id,
      source: 'none',
      file: fs.existsSync(file) ? file : null,
      accessories: normalizeAccessories(null),
      menuSlots: [],
      warning: 'accessories-missing',
    };
  }
  const accessories = normalizeAccessories(raw);
  return {
    modelId: id,
    source: 'body-regions',
    file,
    accessories,
    menuSlots: decorateMenuSlots(menuSlots(accessories)),
  };
}

export function restValueForItem(item, defaults) {
  const param = itemParam(item);
  if (!param) return undefined;
  const map = defaults && typeof defaults === 'object' ? defaults : paramDefaultsFromCatalog();
  if (Object.prototype.hasOwnProperty.call(map, param)) return map[param];
  return undefined;
}

function accessoryLabel(lang, kind, id, fallback) {
  const pack = ACCESSORY_I18N[lang] || ACCESSORY_I18N.zh;
  const map = pack[kind === 'slot' ? 'slots' : 'items'] || {};
  if (map[id]) return map[id];
  const zhMap = ACCESSORY_I18N.zh[kind === 'slot' ? 'slots' : 'items'] || {};
  return zhMap[id] || fallback || id;
}

function decorateMenuSlots(slots) {
  return (slots || []).map((slot) => ({
    ...slot,
    labels: {
      zh: accessoryLabel('zh', 'slot', slot.id, slot.label),
      en: accessoryLabel('en', 'slot', slot.id, slot.label),
      ja: accessoryLabel('ja', 'slot', slot.id, slot.label),
    },
    items: (slot.items || []).map((item) => ({
      ...item,
      restOn: isAccessoryOn(restValueForItem(item), item),
      labels: {
        zh: accessoryLabel('zh', 'item', item.id, item.label),
        en: accessoryLabel('en', 'item', item.id, item.label),
        ja: accessoryLabel('ja', 'item', item.id, item.label),
      },
    })),
  }));
}

export const ACCESSORY_I18N = {
  zh: {
    sectionTitle: '饰品',
    sectionDesc: '按部位分组。每件可独立开关，可同时穿戴；点按即可在角色上切换。',
    sectionHint: '高亮表示已戴。兽耳、翅膀暂无开关，不在此列出。',
    menuRoot: '物品',
    menuTitle: '饰品',
    menuBack: '← 返回',
    empty: '还没有可切换的饰品分组。',
    statusOn: '已戴：{name}',
    statusOff: '已卸下：{name}',
    statusFail: '饰品切换失败：{error}',
    statusIdle: '点按饰品即可开关。',
    langGroup: '饰品文案语言',
    slots: {
      glasses: '眼镜',
      headwear: '头饰',
      tail: '尾巴',
      shoes: '鞋',
      skirt: '裙长',
      'chest-clothes': '胸口衣服',
      flowers: '飘花',
      glints: '逸散光点',
      'mic-glow': '话筒光',
      money: '钱币特效',
    },
    items: {
      monocle: '单片眼镜',
      'black-glasses': '黑框眼镜',
      basin: '钢盆',
      tail: '尾巴',
      'shoes-off': '脱鞋',
      'skirt-toggle': '裙长切换',
      'chest-clothes': '胸口衣服',
      'flower-1': '小花1',
      'flower-2': '小花2',
      'flower-3': '小花3',
      'glint-1': '光点1',
      'glint-2': '光点2',
      'glint-3': '光点3',
      'glint-4': '光点4',
      'mic-glow': '话筒光',
      money: '钱',
    },
  },
  en: {
    sectionTitle: 'Accessories',
    sectionDesc: 'Grouped by slot. Each item toggles on its own and can be worn together. Click to preview on the character.',
    sectionHint: 'A highlight means it is on. Empty slots such as ears and wings are hidden.',
    menuRoot: 'Items',
    menuTitle: 'Accessories',
    menuBack: '← Back',
    empty: 'No togglable accessories in the grouping table.',
    statusOn: 'On: {name}',
    statusOff: 'Off: {name}',
    statusFail: 'Accessory toggle failed: {error}',
    statusIdle: 'Click an accessory to toggle it.',
    langGroup: 'Accessory language',
    slots: {
      glasses: 'Glasses',
      headwear: 'Headwear',
      tail: 'Tail',
      shoes: 'Shoes',
      skirt: 'Skirt',
      'chest-clothes': 'Chest clothes',
      flowers: 'Flowers',
      glints: 'Glints',
      'mic-glow': 'Mic glow',
      money: 'Coin effect',
    },
    items: {
      monocle: 'Monocle',
      'black-glasses': 'Black-framed glasses',
      basin: 'Steel basin',
      tail: 'Tail',
      'shoes-off': 'Take off shoes',
      'skirt-toggle': 'Skirt length',
      'chest-clothes': 'Chest clothes',
      'flower-1': 'Flower 1',
      'flower-2': 'Flower 2',
      'flower-3': 'Flower 3',
      'glint-1': 'Glint 1',
      'glint-2': 'Glint 2',
      'glint-3': 'Glint 3',
      'glint-4': 'Glint 4',
      'mic-glow': 'Mic glow',
      money: 'Coin',
    },
  },
  ja: {
    sectionTitle: 'アクセサリー',
    sectionDesc: '部位ごとにグループ分け。各アイテムは独立したスイッチで、同時に着用できます。クリックするとキャラクターに反映されます。',
    sectionHint: 'ハイライトは装着中です。獣耳・翼などスイッチのない枠は表示しません。',
    menuRoot: 'アイテム',
    menuTitle: 'アクセサリー',
    menuBack: '← 戻る',
    empty: '切り替えられるアクセサリーがありません。',
    statusOn: '装着：{name}',
    statusOff: '外した：{name}',
    statusFail: '切り替えに失敗：{error}',
    statusIdle: 'アクセサリーをクリックして切り替えます。',
    langGroup: 'アクセサリーの言語',
    slots: {
      glasses: 'メガネ',
      headwear: '頭飾り',
      tail: 'しっぽ',
      shoes: '靴',
      skirt: 'スカート丈',
      'chest-clothes': '胸元の服',
      flowers: '小花',
      glints: 'きらめき',
      'mic-glow': 'マイクの光',
      money: 'コイン演出',
    },
    items: {
      monocle: '片眼鏡',
      'black-glasses': '黒縁メガネ',
      basin: '鋼の鉢',
      tail: 'しっぽ',
      'shoes-off': '靴を脱ぐ',
      'skirt-toggle': 'スカート丈切り替え',
      'chest-clothes': '胸元の服',
      'flower-1': '小花1',
      'flower-2': '小花2',
      'flower-3': '小花3',
      'glint-1': '光点1',
      'glint-2': '光点2',
      'glint-3': '光点3',
      'glint-4': '光点4',
      'mic-glow': 'マイクの光',
      money: 'コイン',
    },
  },
};

export function accessoryText(lang, key, vars) {
  const pack = ACCESSORY_I18N[lang] || ACCESSORY_I18N.zh;
  let text = pack[key] || ACCESSORY_I18N.zh[key] || key;
  if (vars) {
    for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]));
  }
  return text;
}
