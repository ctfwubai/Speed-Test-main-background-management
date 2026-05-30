#!/bin/bash

# ============================================================
# 企业内网测速系统 - Ubuntu 一键启动脚本
# 用法: bash start.sh [端口] [密码]
# 示例: bash start.sh 9090 mypassword
# ============================================================

set -euo pipefail

# 颜色定义
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; PURPLE='\033[0;35m'; CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 命令行参数
if [ -n "${1:-}" ]; then PORT=${1}; else PORT="${PORT:-8080}"; fi
if [ -n "${2:-}" ]; then export ADMIN_PASSWORD=$2; fi

echo -e "${PURPLE}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${PURPLE}║       企业内网测速系统 - Enterprise           ║${NC}"
echo -e "${PURPLE}║     Intranet Speed Test System v2.0           ║${NC}"
echo -e "${PURPLE}╚═══════════════════════════════════════════════╝${NC}"
echo ""

# [1] 检测 Node.js
echo -e "${YELLOW}[1/4]${NC} 检测 Node.js 环境..."
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ 未检测到 Node.js${NC}"
  echo "  安装: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

if ! command -v npm &> /dev/null; then
  echo -e "${RED}✗ 未检测到 npm${NC}"; exit 1
fi
echo -e "${GREEN}✓ npm v$(npm -v)${NC}"

# [2] 安装依赖
echo -e "${YELLOW}[2/4]${NC} 检查项目依赖..."
if [ ! -d "node_modules" ]; then
  echo "   正在安装依赖..."
  npm install --no-audit --no-fund
  echo -e "${GREEN}✓ 依赖安装完成${NC}"
else
  echo -e "${GREEN}✓ 依赖已就绪${NC}"
fi

# [3] 清理旧进程
echo -e "${YELLOW}[3/4]${NC} 停止已有 Node.js 服务..."
if pgrep -f "node server.js" > /dev/null 2>&1; then
  pkill -f "node server.js" 2>/dev/null
  sleep 1
  echo -e "${GREEN}✓ 已停止旧服务进程${NC}"
else
  echo -e "${GREEN}✓ 未检测到运行中的服务${NC}"
fi
export PORT

# [4] 获取本机 IP
echo -e "${YELLOW}[4/4]${NC} 获取网络信息..."
IP_LIST=$(hostname -I 2>/dev/null || ip -4 addr show 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -5 || true)
echo -e "${GREEN}✓ 准备就绪${NC}"
sleep 0.3
clear

# 启动信息
echo -e "${PURPLE}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${PURPLE}║       企业内网测速系统 - Enterprise           ║${NC}"
echo -e "${PURPLE}║     Intranet Speed Test System v2.0           ║${NC}"
echo -e "${PURPLE}╚═══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}正在启动服务器...${NC}" ""
echo -e "  ${BLUE}访问地址:${NC}"
echo -e "    ${CYAN}http://localhost:$PORT${NC}"
[ -n "$IP_LIST" ] && echo "$IP_LIST" | while IFS= read -r ip; do
  [ -n "$ip" ] && echo -e "    ${CYAN}http://${ip}:$PORT${NC}"
done
echo ""
echo -e "  ${BLUE}管理后台:${NC}  ${CYAN}http://localhost:$PORT/console/dashboard.html${NC}"
echo -e "  ${BLUE}默认密码:${NC}  ${YELLOW}admin123${NC}"
echo ""
echo -e "  ${YELLOW}提示:${NC} ${ADMIN_PASSWORD:+已设置自定义密码}${ADMIN_PASSWORD:-首次使用建议修改默认密码 | 设置环境变量 ADMIN_PASSWORD=xxx 可自定义密码}"
echo -e "  ${PURPLE}按 Ctrl+C 停止服务器${NC}" ""
echo ""

# 启动服务器（不用 exec，以便捕获退出码）
node server.js
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo -e "${RED}服务器异常退出，错误码: $EXIT_CODE${NC}"
  exit $EXIT_CODE
fi
