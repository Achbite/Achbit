#!/usr/bin/env bash
# Prepare writable dependency volumes and keep the development shell available.
set -euo pipefail

entry_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$entry_dir/scripts/dev-language.sh" ]; then
  source "$entry_dir/scripts/dev-language.sh"
else
  source "$entry_dir/dev-language.sh"
fi
dev_printf '[entrypoint] Starting Achbit development container\n' '[entrypoint] Achbit 开发容器启动\n'
echo "[entrypoint] uname:   $(uname -a)"
echo "[entrypoint] workdir: $(pwd)"

print_version() {
    local name="$1"
    local cmd="$2"
    if command -v "$cmd" >/dev/null 2>&1; then
        echo "[entrypoint] $name: $($cmd --version 2>&1 | head -n1)"
    else
        dev_printf '[entrypoint] %s: <not found>\n' '[entrypoint] %s: <未找到>\n' "$name"
    fi
}
print_version "rustc"    rustc
print_version "cargo"    cargo
print_version "node"     node
print_version "pnpm"     pnpm

for d in \
    "$PWD/node_modules" \
    "$PWD/target" \
    /usr/local/cargo/registry \
    /root/.local/share/pnpm/store
do
    mkdir -p "$d" 2>/dev/null || true
done

if [ "$ACHBIT_DEV_LANGUAGE" = zh-CN ]; then
cat <<'TIP'
[entrypoint] ----------------------------------------------
[entrypoint]  容器已就绪。常用命令（项目根目录直接调用）：
[entrypoint]    bash ./build.sh                  编译并更新本机可运行目录，不生成安装器或压缩包
[entrypoint]    bash ./build.sh --stage package  打包全部可用平台；macOS 经宿主构建通道执行
[entrypoint]    bash ./test.sh    运行 required 登记检查
[entrypoint]    pnpm install （首次或 lockfile 变更时）
[entrypoint] ----------------------------------------------
TIP
else
cat <<'TIP'
[entrypoint] Development container ready. Run these commands from the project root.
[entrypoint]   bash ./build.sh                  Update the local runtime
[entrypoint]   bash ./build.sh --stage package  Package available platforms using the host for macOS
[entrypoint]   bash ./test.sh                   Run required checks
[entrypoint]   pnpm install                     Install dependencies on first use or after lockfile changes
TIP
fi

exec sleep infinity
