#!/usr/bin/env bash
# Bot_Server 一键部署：本地仓库直推（不经 GitHub）→ 远端自检 → systemd 常驻 → 健康检查
# 用法: bash tools/deploy/deploy-bot-server.sh
set -euo pipefail

HOST="121.40.125.77"
USER="root"
KEY="$HOME/.ssh/id_ed25519"
REMOTE_DIR="/opt/dsh-l2d"
PORT=5319
ROOT="D:/Desktop/DSH-L2D"

echo "[1/5] 打包（排除 node_modules/产物/大资源）"
cd "$ROOT"
tar czf /tmp/dsh-l2d-deploy.tgz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='data' \
  --exclude='docs' \
  --exclude='dist' \
  --exclude='*.tgz' \
  --exclude='*.psd' \
  --exclude='*.vbridger' \
  --exclude='*.cdb3' \
  tools/dev-server tools/acceptance \
  packages/dsh-l2d-db/src packages/dsh-l2d-db/test \
  packages/dsh-l2d-plugin/lib \
  packages/dsh-l2d-plugin/assets \
  packages/mcp-bridge \
  packages/dsh-l2d-mcp/src \
  packages/core/src \
  package.json \
  "DeepSeek免费公皮" \
  "vendor/cubism/CubismSdkForWeb-5-r.5/Core/live2dcubismcore.min.js"
# 注意：模型资源（DeepSeek免费公皮）与 Cubism Core 必须打包——
# 2026-11-06 首次部署漏了三大件（模型/Core/renderer.js），调试台 404「渲染包未就绪」。
ls -lh /tmp/dsh-l2d-deploy.tgz

echo "[2/5] 推送并解压"
ssh -i "$KEY" -o BatchMode=yes "$USER@$HOST" "mkdir -p $REMOTE_DIR"
cat /tmp/dsh-l2d-deploy.tgz | ssh -i "$KEY" -o BatchMode=yes "$USER@$HOST" "tar xzf - -C $REMOTE_DIR"

echo "[3/5] 远端自检（bridge 全量测试，失败即中止不上线）"
ssh -i "$KEY" -o BatchMode=yes "$USER@$HOST" "cd $REMOTE_DIR && \
  node --experimental-sqlite packages/mcp-bridge/tests/workspace.test.mjs && \
  node --experimental-sqlite packages/mcp-bridge/tests/status-reporter.test.mjs && \
  node --experimental-sqlite packages/mcp-bridge/tests/mcp-tools.test.mjs && \
  node --experimental-sqlite packages/mcp-bridge/tests/action-queue.test.mjs && \
  node --experimental-sqlite packages/mcp-bridge/tests/continuous.test.mjs && \
  node --experimental-sqlite packages/dsh-l2d-db/test/db.test.mjs && \
  echo REMOTE-TESTS-ALL-GREEN && \
  test -f "vendor/cubism/CubismSdkForWeb-5-r.5/Core/live2dcubismcore.min.js" && \
  test -f "packages/dsh-l2d-plugin/assets/renderer.js" && \
  ls "DeepSeek免费公皮/DeepSeek"/*.moc3 >/dev/null 2>&1 && \
  echo REMOTE-ASSETS-OK"

echo "[4/5] systemd 常驻（dsh-l2d-bot.service，端口 $PORT）"
ssh -i "$KEY" -o BatchMode=yes "$USER@$HOST" "cat > /etc/systemd/system/dsh-l2d-bot.service <<EOF
[Unit]
Description=DSH-L2D Bot Server (dev-server + bridge)
After=network.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_DIR
ExecStart=/usr/bin/node --experimental-sqlite tools/dev-server/index.mjs --port $PORT
Restart=always
RestartSec=3
Environment=NODE_ENV=production
MemoryMax=400M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now dsh-l2d-bot && sleep 2 && systemctl is-active dsh-l2d-bot"

echo "[5/5] 健康检查"
sleep 2
ssh -i "$KEY" -o BatchMode=yes "$USER@$HOST" "curl -s -o /dev/null -w 'local-health:%{http_code}\n' http://127.0.0.1:$PORT/api/models"
curl -s -o /dev/null -m 8 -w "public-health:%{http_code}\n" "http://$HOST:$PORT/api/models" || echo "public-health:UNREACHABLE（多半是阿里云安全组未放行 $PORT，需在控制台加规则）"

echo "DONE。服务: dsh-l2d-bot@$HOST:$PORT"
