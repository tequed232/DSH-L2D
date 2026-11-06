/**
 * physics3.json → 拓扑图（纯函数，无副作用）。
 * 输出 id → 下游输出的传递闭包，是「独占是否波及他域」的唯一判据来源。
 */
import type { PhysicsGraph, PhysicsInput, PhysicsOutput } from './types.ts';

interface RawOutput {
  Destination?: { Id?: string; Weight?: number; Type?: string };
}
interface RawInput {
  Source?: { Id?: string; Weight?: number };
}
interface RawSetting {
  Id?: string;
  Input?: RawInput[];
  Output?: RawOutput[];
}

/** 宽松解析 physics3.json（官方 Cubism 物理文件格式）。 */
export function buildPhysicsGraph(physics3: {
  Meta?: { PhysicsSettingCount?: number; TotalInputCount?: number; TotalOutputCount?: number };
  PhysicsSettings?: RawSetting[];
}): PhysicsGraph {
  const settings = physics3.PhysicsSettings || [];
  const outputs = new Map<string, PhysicsOutput[]>();
  const inputs = new Map<string, PhysicsInput[]>();

  for (const setting of settings) {
    const settingId = setting.Id || '';
    for (const raw of setting.Input || []) {
      const id = raw.Source?.Id;
      if (!id) continue;
      const entry: PhysicsInput = {
        parameterId: id,
        settingId,
        weight: raw.Source?.Weight ?? 1,
        isAlsoOutput: false, // 第二遍填充
      };
      if (!inputs.has(id)) inputs.set(id, []);
      inputs.get(id)!.push(entry);
    }
    for (const raw of setting.Output || []) {
      const id = raw.Destination?.Id;
      if (!id) continue;
      const entry: PhysicsOutput = {
        parameterId: id,
        settingId,
        weight: raw.Destination?.Weight ?? 1,
        type: raw.Destination?.Type || 'Add',
      };
      if (!outputs.has(id)) outputs.set(id, []);
      outputs.get(id)!.push(entry);
    }
  }
  // 双重身份标记：输入 ∩ 输出 = 共享域候选
  for (const [id, list] of inputs) {
    if (outputs.has(id)) for (const entry of list) entry.isAlsoOutput = true;
  }

  // 邻接：setting 的输入 id → 该 setting 的输出 id（物理内部传播边）
  const edges = new Map<string, Set<string>>();
  for (const setting of settings) {
    const inIds = (setting.Input || []).map((r) => r.Source?.Id).filter((s): s is string => !!s);
    const outIds = (setting.Output || []).map((r) => r.Destination?.Id).filter((s): s is string => !!s);
    for (const from of inIds) {
      if (!edges.has(from)) edges.set(from, new Set());
      for (const to of outIds) edges.get(from)!.add(to);
    }
  }

  function downstream(id: string): Set<string> {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      const nexts = edges.get(cur);
      if (!nexts) continue;
      for (const next of nexts) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    seen.delete(id); // 闭包不含起点自身（除非真有回边——物理图不应有）
    return seen;
  }

  return { outputs, inputs, downstream };
}
