/**
 * 包安装器：仅允许白名单化的包管理操作（pnpm install / pnpm add 具名包）。
 * 禁止静默执行任意 Shell 命令；未经授权直接拒绝。
 */
import { spawn } from 'node:child_process';

export interface PackageInstallRequest {
  /** 'install'（恢复 lockfile 依赖）或 'add'（白名单具名包） */
  mode: 'install' | 'add';
  packageSpec?: string; // mode=add 时必填，形如 "typescript@5.9.3"
  cwd: string;
}

const ADD_WHITELIST = /^[a-z0-9@/._-]+@[0-9a-zA-Z.^~><= -]+$/;

export function buildCommand(req: PackageInstallRequest): string[] {
  if (req.mode === 'install') return ['pnpm', ['install', '--prefer-offline']];
  if (req.mode === 'add') {
    if (!req.packageSpec || !ADD_WHITELIST.test(req.packageSpec)) {
      throw new Error(`包名不合法或不在允许格式内：${req.packageSpec}`);
    }
    return ['pnpm', ['add', req.packageSpec]];
  }
  throw new Error(`未知安装模式：${(req as any).mode}`);
}

/** 执行安装（调用方必须已完成授权闸校验）。返回真实退出码。 */
export function runInstall(req: PackageInstallRequest): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((resolveP) => {
    const [cmd, args] = buildCommand(req);
    const child = spawn(cmd, args as string[], {
      cwd: req.cwd,
      shell: false, // 不经 shell，杜绝命令拼装注入
      env: { ...process.env, CI: '1' },
    });
    let output = '';
    child.stdout?.on('data', (d) => (output += String(d)));
    child.stderr?.on('data', (d) => (output += String(d)));
    child.on('error', (e) => resolveP({ ok: false, code: null, output: output + String(e) }));
    child.on('close', (code) => resolveP({ ok: code === 0, code, output }));
  });
}
