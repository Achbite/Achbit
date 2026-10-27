# Achbit Docker environment and thin build entrypoints.

-include .achbit-worktree.mk

# ---- 基础常量（与项目结构强绑定）----
IMAGE_NAME       ?= achbit-dev
IMAGE_TAG        ?= latest
IMAGE            := $(IMAGE_NAME):$(IMAGE_TAG)
DOCKERFILE       ?= Dockerfile.dev
WORKDIR_IN_CTNR  ?= /workspace
ACHBIT_PROJECT_ROOT := $(realpath $(CURDIR))
ACHBIT_BUILD_HOST_OS ?= $(shell uname -s)
UI_PLUGIN ?= ui-plugins/template
UI_PACKAGE ?=
CONTAINER_NAME ?= achbit-dev
CONTAINER_HOSTNAME ?= achbit-dev
ACHBIT_HOST_PORT ?= 31246
ACHBIT_CONTAINER_PORT ?= 31246
ACHBIT_RUST_TOOLCHAIN ?= $(shell awk -F '"' '/^[[:space:]]*channel[[:space:]]*=/ { print $$2; exit }' rust-toolchain.toml)
ACHBIT_RUST_VERSION ?= $(patsubst %.0,%,$(ACHBIT_RUST_TOOLCHAIN))
ACHBIT_APT_MIRROR ?= https://deb.debian.org/debian
ACHBIT_APT_SECURITY_MIRROR ?= https://deb.debian.org/debian-security
ACHBIT_NODE_VERSION ?= 22.22.3
ACHBIT_NODE_DIST_BASE ?= https://npmmirror.com/mirrors/node
ACHBIT_NPM_REGISTRY ?= https://registry.npmmirror.com
ACHBIT_RUSTUP_DIST_SERVER ?= https://mirrors.ustc.edu.cn/rust-static
ACHBIT_RUSTUP_UPDATE_ROOT ?= https://mirrors.ustc.edu.cn/rust-static/rustup
UNAME_R := $(shell uname -r 2>/dev/null)
IS_WSL := $(findstring Microsoft,$(UNAME_R))$(findstring microsoft,$(UNAME_R))
ifneq ($(IS_WSL),)
ACHBIT_BUILD_HOST_OS := Windows_NT
endif
ACHBIT_DOCKER_NET_ENV_PASSTHROUGH ?= auto
ACHBIT_CONTAINER_CARGO_TARGET_DIR ?= $(WORKDIR_IN_CTNR)/target
ACHBIT_CONTAINER_TMPDIR ?= /tmp/achbit-build
ACHBIT_CONTAINER_SCCACHE_DIR ?= $(WORKDIR_IN_CTNR)/target/.sccache
BUILD_ARGS := \
	--build-arg ACHBIT_RUST_VERSION=$(ACHBIT_RUST_VERSION) \
	--build-arg ACHBIT_APT_MIRROR=$(ACHBIT_APT_MIRROR) \
	--build-arg ACHBIT_APT_SECURITY_MIRROR=$(ACHBIT_APT_SECURITY_MIRROR) \
	--build-arg ACHBIT_NODE_VERSION=$(ACHBIT_NODE_VERSION) \
	--build-arg ACHBIT_NODE_DIST_BASE=$(ACHBIT_NODE_DIST_BASE) \
	--build-arg ACHBIT_NPM_REGISTRY=$(ACHBIT_NPM_REGISTRY) \
	--build-arg ACHBIT_RUSTUP_DIST_SERVER=$(ACHBIT_RUSTUP_DIST_SERVER) \
	--build-arg ACHBIT_RUSTUP_UPDATE_ROOT=$(ACHBIT_RUSTUP_UPDATE_ROOT)

# ---- 持久化卷（只有 make clean 才会清空，避免每次 shell 重装依赖）----
VOL_PNPM_STORE        ?= achbit-pnpm-store
VOL_CARGO_REGISTRY    ?= achbit-cargo-registry
ACHBIT_CACHE_SCOPE  ?= $(notdir $(ACHBIT_PROJECT_ROOT))
VOL_CARGO_TARGET      ?= achbit-$(ACHBIT_CACHE_SCOPE)-cargo-target
VOL_NODE_MODULES      ?= achbit-$(ACHBIT_CACHE_SCOPE)-node-modules
VOLUMES_ALL := $(VOL_PNPM_STORE) $(VOL_CARGO_REGISTRY) $(VOL_CARGO_TARGET) $(VOL_NODE_MODULES)

# ---- WSL / Docker 网络变量透传 ----
# 默认只在 WSL 自动启用，避免污染 macOS / Linux Docker 开发环境。
# 仅传变量名，不在日志中展开值；docker run/exec 会从当前 shell 读取同名变量。
NETWORK_ENV_ARGS_BASE := \
	-e HTTP_PROXY \
	-e HTTPS_PROXY \
	-e ALL_PROXY \
	-e NO_PROXY \
	-e http_proxy \
	-e https_proxy \
	-e all_proxy \
	-e no_proxy \
	-e CARGO_HTTP_PROXY \
	-e CARGO_HTTP_TIMEOUT \
	-e CARGO_HTTP_CAINFO \
	-e CARGO_HTTP_PROXY_CAINFO

ifeq ($(ACHBIT_DOCKER_NET_ENV_PASSTHROUGH),1)
NETWORK_ENV_ARGS := $(NETWORK_ENV_ARGS_BASE)
else ifeq ($(ACHBIT_DOCKER_NET_ENV_PASSTHROUGH),0)
NETWORK_ENV_ARGS :=
else ifneq ($(IS_WSL),)
NETWORK_ENV_ARGS := $(NETWORK_ENV_ARGS_BASE)
else
NETWORK_ENV_ARGS :=
endif

# ---- 容器运行参数 ----
# - 当前 worktree 挂载到 WORKDIR_IN_CTNR
# - named volumes 覆盖 node_modules / target，避免 Windows ↔ WSL ↔ 容器 IO 雪崩
# - 开发容器允许 Bubblewrap 建立内层 namespace / mount；产品沙箱策略保持独立
RUN_ARGS := \
	--name $(CONTAINER_NAME) \
	--hostname $(CONTAINER_HOSTNAME) \
	--init \
	--cap-add=SYS_ADMIN \
	--security-opt=apparmor=unconfined \
	--security-opt=seccomp=unconfined \
	--security-opt=systempaths=unconfined \
	--label "com.achbit.project.root=$(ACHBIT_PROJECT_ROOT)" \
	-w "$(WORKDIR_IN_CTNR)" \
	-p 127.0.0.1:$(ACHBIT_HOST_PORT):$(ACHBIT_CONTAINER_PORT) \
	-v "$(ACHBIT_PROJECT_ROOT):$(WORKDIR_IN_CTNR)" \
	-v $(VOL_PNPM_STORE):/root/.local/share/pnpm/store \
	-v $(VOL_CARGO_REGISTRY):/usr/local/cargo/registry \
	-v $(VOL_CARGO_TARGET):$(WORKDIR_IN_CTNR)/target \
	-v $(VOL_NODE_MODULES):$(WORKDIR_IN_CTNR)/node_modules \
	-e CARGO_HOME=/usr/local/cargo \
	-e RUSTUP_HOME=/usr/local/rustup \
	-e PNPM_HOME=/root/.local/share/pnpm \
	-e PNPM_STORE_DIR=/root/.local/share/pnpm/store \
	-e ACHBIT_WINDOWS_NODE_BIN=/opt/achbit-node-win64/node.exe \
	-e ACHBIT_NODE_LICENSE=/usr/local/LICENSE \
	-e CARGO_TARGET_DIR=$(ACHBIT_CONTAINER_CARGO_TARGET_DIR) \
	-e ACHBIT_TMPDIR=$(ACHBIT_CONTAINER_TMPDIR) \
	-e SCCACHE_DIR=$(ACHBIT_CONTAINER_SCCACHE_DIR) \
	-e ACHBIT_BUILD_HOST_OS=$(ACHBIT_BUILD_HOST_OS) \
	-e ACHBIT_MACOS_SIGN_IDENTITY \
	-e PATH=/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
	$(NETWORK_ENV_ARGS)

.PHONY: help docker-info branch-audit branch-hooks shell build package ui ui-update native-gui dev-achbit-gui reset-dev clean package-macos _validate_config _print_image _ensure_image _ensure_container

# Environment settings are forwarded to the sole build orchestrator.
export CONTAINER_NAME WORKDIR_IN_CTNR

help:
	@echo "make shell / docker-info / reset-dev: 当前 worktree 的 Docker 环境；Mac 自动准备宿主打包通道"
	@echo "make build: 编译并更新本机可运行目录；macOS 更新 bin/macos-arm64，不生成安装器或压缩包"
	@echo "make package: 编译并打包全部可用平台，生成运行目录、压缩包及安装器"
	@echo "make package-macos: Docker 共享构建 + 宿主 Darwin 编译/组装，支持容器内 build.sh 发起"
	@echo "make ui: 单 GUI 资源到 bin/ui/web-achbit-gui"
	@echo "make ui-update UI_PACKAGE=bin/macos-arm64: 完整替换本地包 GUI"
	@echo "make native-gui: Docker 内构建 Linux GUI native shell"
	@echo "make dev-achbit-gui: Docker 内 Vite HMR，浏览器访问已映射的 Host 端口"
	@echo "make clean: 删除当前配置的容器、镜像和缓存 volumes"

docker-info:
	@echo "projectRoot=$(ACHBIT_PROJECT_ROOT)"
	@echo "macosOutputRoot=$(ACHBIT_PROJECT_ROOT)/bin/macos-arm64"
	@echo "rustToolchain=$(ACHBIT_RUST_TOOLCHAIN)"
	@echo "rustVersion=$(ACHBIT_RUST_VERSION)"
	@echo "image=$(IMAGE)"
	@echo "container=$(CONTAINER_NAME)"
	@echo "hostname=$(CONTAINER_HOSTNAME)"
	@echo "hostPort=$(ACHBIT_HOST_PORT)"
	@echo "containerPort=$(ACHBIT_CONTAINER_PORT)"
	@echo "cargoTargetVolume=$(VOL_CARGO_TARGET)"
	@echo "nodeModulesVolume=$(VOL_NODE_MODULES)"

branch-audit:
	@bash ./scripts/branch-flow.sh audit

branch-hooks:
	@bash ./scripts/branch-flow.sh install-hooks

_validate_config:
	@if [ ! -d "$(ACHBIT_PROJECT_ROOT)" ]; then \
		echo "[make][error] 项目根目录不可用: $(ACHBIT_PROJECT_ROOT)" >&2; \
		exit 1; \
	fi
	@if [ -z "$(ACHBIT_RUST_TOOLCHAIN)" ] || [ -z "$(ACHBIT_RUST_VERSION)" ]; then \
		echo "[make][error] rust-toolchain.toml 缺少有效 channel" >&2; \
		exit 1; \
	fi
	@case "$(ACHBIT_HOST_PORT)" in ''|*[!0-9]*) echo "[make][error] ACHBIT_HOST_PORT 必须是 1-65535 的整数" >&2; exit 1;; esac
	@if [ "$(ACHBIT_HOST_PORT)" -lt 1 ] || [ "$(ACHBIT_HOST_PORT)" -gt 65535 ]; then \
		echo "[make][error] ACHBIT_HOST_PORT 必须是 1-65535 的整数" >&2; \
		exit 1; \
	fi

package-macos:
	@bash ./build.sh --stage package-macos

# ---- _ensure_image：每次求值 Dockerfile，未变化时直接命中 Docker 缓存 ----
_print_image:
	@printf '%s\n' '$(IMAGE)'

_ensure_image: _validate_config
	@echo "[make] 更新开发镜像 $(IMAGE)（未变化层使用 Docker 缓存）..."
	@docker build --provenance=false $(BUILD_ARGS) -f $(DOCKERFILE) -t $(IMAGE) .

# ---- _ensure_container：容器懒创建 / 刷新启动 ----
# 状态机：
#   not exists  -> docker run -d
#   stale       -> 精确移除该容器后重建（源码挂载、镜像、宿主平台、端口或嵌套沙箱配置变化）
#   running     -> reuse
#   exited      -> docker start
_ensure_container: _ensure_image
	@if docker container inspect $(CONTAINER_NAME) >/dev/null 2>&1; then \
		mounted_root=$$(docker container inspect -f '{{range .Mounts}}{{if eq .Destination "$(WORKDIR_IN_CTNR)"}}{{.Source}}{{end}}{{end}}' $(CONTAINER_NAME)); \
		container_host_os=$$(docker container inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $(CONTAINER_NAME) | sed -n 's/^ACHBIT_BUILD_HOST_OS=//p'); \
		container_image=$$(docker container inspect -f '{{.Image}}' $(CONTAINER_NAME)); \
		current_image=$$(docker image inspect -f '{{.Id}}' $(IMAGE)); \
		actual_host_port=$$(docker container port $(CONTAINER_NAME) $(ACHBIT_CONTAINER_PORT)/tcp 2>/dev/null | awk -F: 'NR == 1 { print $$NF }'); \
		container_caps=$$(docker container inspect -f '{{range .HostConfig.CapAdd}}{{println .}}{{end}}' $(CONTAINER_NAME)); \
		container_security=$$(docker container inspect -f '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' $(CONTAINER_NAME)); \
		container_system_paths=$$(docker container inspect -f '{{len .HostConfig.MaskedPaths}} {{len .HostConfig.ReadonlyPaths}}' $(CONTAINER_NAME)); \
		reason=""; \
		if [ "$$mounted_root" != "$(ACHBIT_PROJECT_ROOT)" ]; then reason="源码挂载已变化"; \
		elif [ "$$container_image" != "$$current_image" ]; then reason="开发镜像已更新"; \
		elif [ "$$container_host_os" != "$(ACHBIT_BUILD_HOST_OS)" ]; then reason="构建宿主平台已变化或缺失"; \
		elif [ "$$actual_host_port" != "$(ACHBIT_HOST_PORT)" ]; then reason="端口配置已变化"; \
		elif ! printf '%s\n' "$$container_caps" | grep -Eq '^(CAP_)?SYS_ADMIN$$' \
			|| ! printf '%s\n' "$$container_security" | grep -Fxq 'apparmor=unconfined' \
			|| ! printf '%s\n' "$$container_security" | grep -Fxq 'seccomp=unconfined' \
			|| [ "$$container_system_paths" != '0 0' ]; then reason="Bubblewrap 嵌套沙箱配置已变化"; \
		fi; \
		if [ -n "$$reason" ]; then \
			echo "[make] $${reason}，重建唯一容器 $(CONTAINER_NAME) 并保留 named volumes..."; \
			docker rm -f $(CONTAINER_NAME) >/dev/null; \
		fi; \
	fi; \
	if ! docker container inspect $(CONTAINER_NAME) >/dev/null 2>&1; then \
		echo "[make] 创建并启动唯一容器 $(CONTAINER_NAME)..."; \
		docker run -d $(RUN_ARGS) $(IMAGE) /usr/local/bin/entrypoint.sh >/dev/null; \
	else \
		status=$$(docker container inspect -f '{{.State.Status}}' $(CONTAINER_NAME) 2>/dev/null | tr -d '[:space:]'); \
		case "$$status" in \
			running) \
				echo "[make] 容器 $(CONTAINER_NAME) 正在运行，直接复用"; \
				;; \
			exited|created) \
				echo "[make] 容器 $(CONTAINER_NAME) 处于 $$status，start 启动..."; \
				docker start $(CONTAINER_NAME) >/dev/null ; \
				;; \
			paused) \
				echo "[make] 容器 $(CONTAINER_NAME) 已暂停，unpause 恢复..."; \
				docker unpause $(CONTAINER_NAME) >/dev/null ; \
				;; \
			dead) \
				echo "[make] 容器 $(CONTAINER_NAME) 已失效，精确重建并保留 named volumes..."; \
				docker rm -f $(CONTAINER_NAME) >/dev/null ; \
				docker run -d $(RUN_ARGS) $(IMAGE) /usr/local/bin/entrypoint.sh >/dev/null ; \
				;; \
			*) \
				echo "[make][error] 不支持的容器状态 [$$status]；请执行 make reset-dev" >&2; \
				exit 1; \
				;; \
		esac; \
	fi
	@if [ "$(ACHBIT_BUILD_HOST_OS)" = Darwin ]; then python3 scripts/macos-build-bridge.py ensure; fi

# ---- shell：唯一交互入口 ----
shell: _ensure_container
	@echo "[make] exec 进入容器 $(CONTAINER_NAME) ..."
	@docker exec -it $(NETWORK_ENV_ARGS) -e ACHBIT_BUILD_HOST_OS=$(ACHBIT_BUILD_HOST_OS) -e ACHBIT_MACOS_SIGN_IDENTITY $(CONTAINER_NAME) bash

build:
	@bash ./build.sh

package:
	@bash ./build.sh --stage package

ui:
	@bash ./build.sh --stage ui

ui-update:
	@test -n "$(UI_PACKAGE)" || { echo '请指定 UI_PACKAGE，例如 bin/macos-arm64 或 bin/win64' >&2; exit 2; }
	@bash ./build.sh --stage ui
	@python3 ./scripts/update-ui.py --package "$(UI_PACKAGE)"

native-gui:
	@bash ./build.sh --stage native-gui

dev-achbit-gui: _ensure_container
	@bash scripts/dev-achbit-gui-host.sh "$(CONTAINER_NAME)" "$(WORKDIR_IN_CTNR)" "$(ACHBIT_CONTAINER_PORT)" $(NETWORK_ENV_ARGS)

# ---- reset-dev / clean：只操作固定命名的单仓开发资源 ----
reset-dev:
	@if [ "$(ACHBIT_BUILD_HOST_OS)" = Darwin ]; then python3 scripts/macos-build-bridge.py stop; fi
	@echo "[make] 移除唯一开发容器 $(CONTAINER_NAME)，保留依赖与编译缓存 ..."
	-@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
	@echo "[make] 重置完成；下次 make shell/build 会按当前源码与镜像重建容器。"

clean:
	@if [ "$(ACHBIT_BUILD_HOST_OS)" = Darwin ]; then python3 scripts/macos-build-bridge.py stop; fi
	@echo "[make] 强制移除容器 $(CONTAINER_NAME) ..."
	-@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
	@echo "[make] 强制移除镜像 $(IMAGE) ..."
	-@docker rmi -f $(IMAGE) >/dev/null 2>&1 || true
	@echo "[make] 移除 named volumes ..."
	-@for v in $(VOLUMES_ALL); do \
		docker volume rm $$v >/dev/null 2>&1 && echo "  - removed volume $$v" || echo "  - skip $$v (不存在)"; \
	done
	@echo "[make] 清理完成。下次 'make shell' 将重建当前配置需要的容器环境。"
	@echo "[make] 注意：宿主机 ./bin、./node_modules（如存在于宿主端）未被本目标修改。"

.PHONY: ui-plugin ui-plugin-watch
ui-plugin: _ensure_container
	@docker exec -e ACHBIT_UI_PLUGIN_ROOT="$(WORKDIR_IN_CTNR)/$(UI_PLUGIN)" $(CONTAINER_NAME) pnpm --filter @achbit/client exec vite build --config vite.ui-plugin.config.ts
ui-plugin-watch: _ensure_container
	@docker exec -e ACHBIT_UI_PLUGIN_ROOT="$(WORKDIR_IN_CTNR)/$(UI_PLUGIN)" $(CONTAINER_NAME) pnpm --filter @achbit/client exec vite build --config vite.ui-plugin.config.ts --watch
