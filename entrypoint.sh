#!/usr/bin/env bash
# ====================================================================
# DeepCode 开发容器入口脚本
# 职责：
#   1. 打印环境概要（rustc / cargo / node / pnpm）
#   2. 校准 PATH 与可写权限（首次启动时确保 named volume 子目录存在）
#   3. 前台保活，等待 docker exec 进入交互式 bash
# 注意：本脚本 *不* 自动执行 pnpm install / cargo build，
#       依赖安装由用户在容器内执行 bash ./build.sh 触发，避免 make shell 卡顿。
# ====================================================================
set -euo pipefail

echo "[entrypoint] DeepCode 开发容器启动"
echo "[entrypoint] uname:   $(uname -a)"
echo "[entrypoint] workdir: $(pwd)"

# ---- 1. 关键工具版本 ----
# 任何工具缺失都不应中断保活；只打印警告
print_version() {
    local name="$1"
    local cmd="$2"
    if command -v "$cmd" >/dev/null 2>&1; then
        echo "[entrypoint] $name: $($cmd --version 2>&1 | head -n1)"
    else
        echo "[entrypoint] $name: <not found>"
    fi
}
print_version "rustc"    rustc
print_version "cargo"    cargo
print_version "node"     node
print_version "pnpm"     pnpm

# ---- 2. 准备 named volume 挂载点权限 ----
# named volume 首次挂载时是空目录，root 拥有；这里显式确保可写
for d in \
    "$PWD/node_modules" \
    "$PWD/target" \
    /usr/local/cargo/registry \
    /root/.local/share/pnpm/store
do
    mkdir -p "$d" 2>/dev/null || true
done

# ---- 3. 友好提示 ----
cat <<'TIP'
[entrypoint] ----------------------------------------------
[entrypoint]  容器已就绪。常用命令（项目根目录直接调用）：
[entrypoint]    bash ./build.sh                  编译并更新本机可运行目录，不生成安装器或压缩包
[entrypoint]    bash ./build.sh --stage package  打包全部可用平台；macOS 经宿主构建通道执行
[entrypoint]    bash ./test.sh    运行 required 登记检查
[entrypoint]    pnpm install （首次或 lockfile 变更时）
[entrypoint] ----------------------------------------------
TIP

# ---- 4. 前台保活 ----
# 不使用 `tail -f /dev/null`：sleep infinity 在收到 SIGTERM 时退出更干净
exec sleep infinity
