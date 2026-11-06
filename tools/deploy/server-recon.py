"""Bot_Server 只读侦察：环境摸底，不做任何变更。"""
import json
import paramiko

HOST, USER, PWD = "121.40.125.77", "root", "Luo20080523"

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PWD, timeout=15, look_for_keys=False, allow_agent=False)

CMDS = {
    "os": "cat /etc/os-release | head -2",
    "kernel": "uname -r",
    "cpu_mem": "nproc; free -h | head -2",
    "disk": "df -h / | tail -1",
    "node": "node -v 2>/dev/null || echo no-node",
    "npm_pnpm": "npm -v 2>/dev/null; pnpm -v 2>/dev/null || echo no-pnpm",
    "git": "git --version 2>/dev/null || echo no-git",
    "github_reach": "timeout 6 curl -sI https://github.com -o /dev/null -w '%{http_code}' 2>&1 || echo FAIL",
    "npmjs_reach": "timeout 6 curl -sI https://registry.npmjs.org -o /dev/null -w '%{http_code}' 2>&1 || echo FAIL",
    "ports_in_use": "ss -tlnp | awk '{print $4}' | tail -n +2 | grep -oE '[0-9]+$' | sort -un | tr '\n' ' '",
    "systemd": "systemctl --version | head -1",
    "home_ls": "ls /root 2>/dev/null | head -15",
}

out = {}
for k, cmd in CMDS.items():
    _, stdout, stderr = c.exec_command(cmd, timeout=20)
    out[k] = (stdout.read().decode(errors="replace").strip() or stderr.read().decode(errors="replace").strip())
c.close()
print(json.dumps(out, ensure_ascii=False, indent=1))
