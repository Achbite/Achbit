#!/usr/bin/env bash
# Local development checks use the actual build and runtime entrypoints.
# Verify backend, display and input behavior, including permission and question routing.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/source-identity.sh"
source "$ROOT_DIR/scripts/dev-language.sh"

profile='required'
skipped_checks=0
if [ "${1:-}" = '--profile' ]; then
  [ "$#" -eq 2 ] || { dev_printf 'Usage: %s --profile <static|required|cli|full>\n' '用法：%s --profile <static|required|cli|full>\n' "$0" >&2; exit 2; }
  profile="$2"
elif [ "$#" -eq 1 ]; then
  profile="$1"
elif [ "$#" -ne 0 ]; then
  dev_printf 'Usage: %s [static|required|cli|full]\n' '用法：%s [static|required|cli|full]\n' "$0" >&2
  exit 2
fi

case "$profile" in
  static|required|cli|full) ;;
  help|-h|--help)
    dev_printf 'Usage: %s [static|required|cli|full]\n' '用法：%s [static|required|cli|full]\n' "$0"
    exit 0
    ;;
  *) dev_printf 'Unknown verification profile: %s\n' '未知验证范围：%s\n' "$profile" >&2; exit 2 ;;
esac

if [ "$profile" != 'static' ]; then
  if [ ! -f /.dockerenv ] && ! grep -qaE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null; then
    dev_printf 'Run required/cli/full in the development container. Open it with make shell.\n' 'required/cli/full 验证必须在开发容器内执行；请先运行 make shell。\n' >&2
    exit 3
  fi
  for tool in cargo node pnpm python3; do
    command -v "$tool" >/dev/null 2>&1 || { dev_printf 'Missing command: %s\n' '缺少命令：%s\n' "$tool" >&2; exit 1; }
  done
fi
run_static() {
  python3 scripts/version.py check
  dev_printf '[test] Shell syntax and diff formatting\n' '[test] 脚本语法与 diff 格式\n'
  local script
  for script in ./test.sh ./build.sh ./entrypoint.sh ./scripts/*.sh; do
    bash -n "$script"
  done
  if achbit_source_git_available "$ROOT_DIR"; then
    achbit_source_git "$ROOT_DIR" diff --check
  else
    dev_printf '[test] Git diff check: SKIP (Git metadata is host-owned and unavailable in this compile/test snapshot)\n' '[test] Git diff 检查：SKIP（此编译测试快照无法读取宿主 Git 元数据）\n'
    skipped_checks=$((skipped_checks + 1))
  fi
}

run_required() {
  run_static
  dev_printf '[test] Rust workspace\n' '[test] Rust 工作区\n'
  cargo fmt --all -- --check
  cargo test --workspace
  dev_printf '[test] Debug control contracts\n' '[test] Debug 控制专用合同\n'
  cargo test -p achbit-kernel-daemon -p achbit-cli --features achbit-kernel-daemon/debug-control,achbit-cli/debug-control debug
  dev_printf '[test] Build orchestration and program publishing\n' '[test] 构建编排与程序发布\n'
  python3 -I -S ./scripts/tests/version.py
  python3 -I -S ./scripts/tests/build-platforms.py
  python3 -I -S ./scripts/tests/release.py
  dev_printf '[test] GUI asset publishing\n' '[test] GUI 资源发布\n'
  python3 -I -S ./scripts/tests/ui-update.py
  dev_printf '[test] Shared userspace dependencies\n' '[test] Userspace 共享依赖\n'
  pnpm --store-dir "${PNPM_STORE_DIR:-${PNPM_HOME:-$HOME/.local/share/pnpm}/store}" install --frozen-lockfile
  pnpm build:userspace-shared
  dev_printf '[test] TUI fonts and window launch arguments\n' '[test] TUI 字体选择与窗口启动参数\n'
  node --test ./shells/tui/tests/*.test.mjs
  dev_printf '[test] Session data flow\n' '[test] Session 数据流\n'
  pnpm --filter @achbit/session-core test
  dev_printf '[test] GUI projection contracts and state interactions\n' '[test] GUI 投影合同与状态交互\n'
  pnpm --filter @achbit/client test
  dev_printf '[test] GUI types (shared packages built)\n' '[test] GUI 类型接线（共享包已编译）\n'
  pnpm --filter @achbit/client typecheck
  dev_printf '[test] Manual preview types\n' '[test] 手工预览类型接线\n'
  pnpm --filter @achbit/client typecheck:manual
}

run_workspace_shell() {
  dev_printf '[test] Workspace Shell CLI\n' '[test] 工作区 Shell CLI\n'
  local workspace_status=0
  python3 -I -S ./scripts/tests/workspace-shell-cli.py || workspace_status=$?
  case "$workspace_status" in
    0) ;;
    77)
      skipped_checks=$((skipped_checks + 1))
      dev_printf '[test] Workspace Shell CLI: SKIP (sandbox UNAVAILABLE; see the reason above; isolation was not verified)\n' '[test] 工作区 Shell CLI：SKIP（沙箱不可用，原因见上文；未验证隔离行为）\n'
      ;;
    *)
      dev_printf '[test] Workspace Shell CLI: FAIL (exit=%s)\n' '[test] 工作区 Shell CLI：FAIL（exit=%s）\n' "$workspace_status" >&2
      return "$workspace_status"
      ;;
  esac
}

run_cli_e2e() {
  python3 -I -S ./scripts/tests/owned-daemon.py
  python3 -I -S ./scripts/tests/plugin-repair-cli.py
  if [ "$profile" = full ]; then
    dev_printf '[test] Local Agent runtime and shared projection shells\n' '[test] 本地 Agent 真实链路与共享投影壳\n'
  fi
  python3 -I -S ./scripts/tests/tool-input-cli-e2e.py
  python3 -I -S ./scripts/tests/shared-coding-cli.py
  python3 -I -S ./scripts/tests/project-skills-cli.py
  python3 -I -S ./scripts/tests/provider-retry-cli.py
  python3 -I -S ./scripts/tests/host-update-cli.py
  python3 -I -S ./scripts/tests/host-restart-cli.py
  python3 -I -S ./scripts/tests/permission-delegation-cli.py
  python3 -I -S ./scripts/tests/agent-composition-cli.py
  python3 -I -S ./scripts/tests/file-access-cli.py
  run_workspace_shell
  python3 -I -S ./scripts/tests/managed-process-cli.py
  python3 -I -S ./scripts/tests/subagent-cli.py
  python3 -I -S ./scripts/tests/subagent-capacity-cli.py
  python3 -I -S ./scripts/tests/conversation-storage.py
  python3 -I -S ./scripts/tests/large-journal-cli.py
}

# E2E scripts consume the outputs selected here; direct calls must supply these paths.
if [ "$profile" = cli ] || [ "$profile" = full ]; then
  test_target_dir="${CARGO_TARGET_DIR:-$ROOT_DIR/target}"
  export ACHBIT_E2E_DAEMON="${ACHBIT_E2E_DAEMON:-$test_target_dir/debug/achbit-kernel-daemon}"
  export ACHBIT_E2E_CLI="${ACHBIT_E2E_CLI:-$test_target_dir/debug/achbit-cli}"
  export ACHBIT_E2E_TUI="${ACHBIT_E2E_TUI:-$test_target_dir/debug/achbit-tui}"
  export ACHBIT_E2E_SESSION_BRIDGE="${ACHBIT_E2E_SESSION_BRIDGE:-$ROOT_DIR/userspace/session-core/dist/sessionServiceBridge.js}"
fi

case "$profile" in
  static) run_static ;;
  required) run_required ;;
  cli)
    run_required
    dev_printf '[test] CLI and daemon entrypoints\n' '[test] CLI 与 daemon 正式入口\n'
    cargo build -p achbit-first-party-tools -p achbit-kernel-daemon -p achbit-cli -p achbit-tui
    run_cli_e2e
    ;;
  full)
    run_required
    dev_printf '[test] Packaged CLI, TUI and GUI entrypoints\n' '[test] CLI、TUI 与 GUI 正式包入口\n'
    cargo build -p achbit-first-party-tools -p achbit-kernel-daemon -p achbit-cli -p achbit-tui -p achbit-host-web
    pnpm --filter @achbit/client build:web
    run_cli_e2e
    python3 -I -S ./scripts/tests/local-agent-e2e.py
    python3 -I -S ./scripts/tests/document-render-e2e.py
    ;;
esac

dev_printf '[test] Checks finished profile=%s, skipped=%s (SKIP is not a pass; these checks do not measure quality, stability, live providers or release acceptance)\n' '[test] 登记链路检查完成 profile=%s，入口跳过=%s（SKIP 不计通过；测试不等于效果、稳定性、真实 Provider 或发布验收）\n' "$profile" "$skipped_checks"
