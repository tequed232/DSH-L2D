/**
 * keyframes 轨道的准入判定（纯函数，便于单测）。
 *
 * 规则：只拒绝「参数不存在」与「口型红线」；物理输出一律接受，
 * 由 playKeyframes 在准入之后统一自动认领（own），避免出现
 * 「未预先 own 的物理输出轨道被整条丢弃 → no-valid-tracks」。
 */
export interface KeyframeTrackProbe {
  /** 参数是否真实存在于当前模型 */
  exists: boolean;
  /** 是否口型禁区参数（任何通道都不写） */
  lipsync: boolean;
  /** 是否物理输出（需要自动认领后才能写） */
  physicsOutput: boolean;
}

export interface KeyframeAdmission {
  accepted: boolean;
  /** 接受后是否需要自动认领（物理输出） */
  autoOwn: boolean;
  reason?: 'unknown-param' | 'lipsync';
}

export function admitKeyframeTrack(probe: KeyframeTrackProbe): KeyframeAdmission {
  if (!probe.exists) return { accepted: false, autoOwn: false, reason: 'unknown-param' };
  if (probe.lipsync) return { accepted: false, autoOwn: false, reason: 'lipsync' };
  return { accepted: true, autoOwn: probe.physicsOutput };
}
