# Achbit Docker environment and thin build entrypoints.

-include .achbit-worktree.mk

# Project constants
IMAGE_NAME       ?= achbit-dev
IMAGE_TAG        ?= latest
IMAGE            := $(IMAGE_NAME):$(IMAGE_TAG)
DOCKERFILE       ?= Dockerfile.dev
WORKDIR_IN_CTNR  ?= /workspace
ACHBIT_PROJECT_ROOT := $(realpath $(CURDIR))
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
ACHBIT_BUILD_HOST_OS ?= $(if $(IS_WSL),Windows_NT,$(shell uname -s))
ACHBIT_DOCKER_NET_ENV_PASSTHROUGH ?= auto
ACHBIT_CONTAINER_CARGO_TARGET_DIR ?= $(WORKDIR_IN_CTNR)/target
ACHBIT_CONTAINER_TMPDIR ?= /tmp/achbit-build
ACHBIT_CONTAINER_SCCACHE_DIR ?= $(WORKDIR_IN_CTNR)/target/.sccache
WINDOWS_SIGNING_DIR := $(or $(ACHBIT_WINDOWS_SIGNING_DIR),$(HOME)/.config/achbit/windows-signing)
WINDOWS_SIGNING_SOURCE := $(shell if test -d "$(WINDOWS_SIGNING_DIR)"; then cd "$(WINDOWS_SIGNING_DIR)" && pwd -P; fi)
BUILD_ARGS := \
	--build-arg ACHBIT_RUST_VERSION=$(ACHBIT_RUST_VERSION) \
	--build-arg ACHBIT_APT_MIRROR=$(ACHBIT_APT_MIRROR) \
	--build-arg ACHBIT_APT_SECURITY_MIRROR=$(ACHBIT_APT_SECURITY_MIRROR) \
	--build-arg ACHBIT_NODE_VERSION=$(ACHBIT_NODE_VERSION) \
	--build-arg ACHBIT_NODE_DIST_BASE=$(ACHBIT_NODE_DIST_BASE) \
	--build-arg ACHBIT_NPM_REGISTRY=$(ACHBIT_NPM_REGISTRY) \
	--build-arg ACHBIT_RUSTUP_DIST_SERVER=$(ACHBIT_RUSTUP_DIST_SERVER) \
	--build-arg ACHBIT_RUSTUP_UPDATE_ROOT=$(ACHBIT_RUSTUP_UPDATE_ROOT)

# Persistent dependency and build volumes removed by make clean
VOL_PNPM_STORE        ?= achbit-pnpm-store
VOL_CARGO_REGISTRY    ?= achbit-cargo-registry
ACHBIT_CACHE_SCOPE  ?= $(notdir $(ACHBIT_PROJECT_ROOT))
VOL_CARGO_TARGET      ?= achbit-$(ACHBIT_CACHE_SCOPE)-cargo-target
VOL_NODE_MODULES      ?= achbit-$(ACHBIT_CACHE_SCOPE)-node-modules
VOLUMES_ALL := $(VOL_PNPM_STORE) $(VOL_CARGO_REGISTRY) $(VOL_CARGO_TARGET) $(VOL_NODE_MODULES)

# Network environment forwarded to WSL / Docker
# Automatic forwarding applies to WSL by default.
# Pass variable names. Docker reads their values from the calling shell.
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

# Container options
# Mount the current worktree at WORKDIR_IN_CTNR.
# Use named volumes for node_modules and target to avoid cross-filesystem I/O.
# Allow nested Bubblewrap mounts and namespaces for development.
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
	-e ACHBIT_DEV_LANGUAGE \
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

ifneq ($(WINDOWS_SIGNING_SOURCE),)
RUN_ARGS += -v "$(WINDOWS_SIGNING_SOURCE):/run/secrets/achbit-windows-signing:ro"
endif

.PHONY: help docker-info branch-audit branch-hooks shell build package ui ui-update native-gui dev-achbit-gui reset-dev clean package-macos _validate_config _print_image _ensure_image _ensure_container

# Environment settings are forwarded to the sole build orchestrator.
export CONTAINER_NAME WORKDIR_IN_CTNR
ACHBIT_DEV_LANGUAGE := $(shell . ./scripts/dev-language.sh && printf '%s' "$$ACHBIT_DEV_LANGUAGE")
export ACHBIT_DEV_LANGUAGE
dev_text = $(if $(filter zh-CN,$(ACHBIT_DEV_LANGUAGE)),$(2),$(1))

help:
	@echo "make shell / docker-info / reset-dev: $(call dev_text,Docker environment for this worktree. macOS also prepares host packaging.,当前 worktree 的 Docker 环境；Mac 自动准备宿主打包通道)"
	@echo "make shell: $(call dev_text,Refresh image inputs and reuse cached layers.,自动检查镜像输入；有改动时更新，未变化层直接复用 Docker 缓存)"
	@echo "make build: $(call dev_text,Update the local runtime. macOS writes bin/macos-arm64.,编译并更新本机可运行目录；macOS 更新 bin/macos-arm64，不生成安装器或压缩包)"
	@echo "make package: $(call dev_text,Build runtimes and distribution archives and installers for available platforms.,编译并打包全部可用平台，生成运行目录、压缩包及安装器)"
	@echo "make package-macos: $(call dev_text,Build shared resources in Docker and assemble the Darwin package on the host.,Docker 共享构建 + 宿主 Darwin 编译/组装，支持容器内 build.sh 发起)"
	@echo "make ui: $(call dev_text,Build GUI assets in bin/ui/web-achbit-gui.,单 GUI 资源到 bin/ui/web-achbit-gui)"
	@echo "make ui-update UI_PACKAGE=bin/macos-arm64: $(call dev_text,Replace the GUI in a local package.,完整替换本地包 GUI)"
	@echo "make native-gui: $(call dev_text,Build the native Linux GUI shell in Docker.,Docker 内构建 Linux GUI native shell)"
	@echo "make dev-achbit-gui: $(call dev_text,Start Vite HMR in Docker on the mapped Host port.,Docker 内 Vite HMR，浏览器访问已映射的 Host 端口)"
	@echo "make clean: $(call dev_text,Remove the configured container and its image and cache volumes.,删除当前配置的容器、镜像和缓存 volumes)"

docker-info:
	@echo "projectRoot=$(ACHBIT_PROJECT_ROOT)"
	@echo "macosOutputRoot=$(ACHBIT_PROJECT_ROOT)/bin/macos-arm64"
	@echo "rustToolchain=$(ACHBIT_RUST_TOOLCHAIN)"
	@echo "rustVersion=$(ACHBIT_RUST_VERSION)"
	@echo "image=$(IMAGE)"
	@echo "container=$(CONTAINER_NAME)"
	@echo "workdir=$(WORKDIR_IN_CTNR)"
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
	@if [ -n "$(ACHBIT_WINDOWS_SIGNING_DIR)" ] && [ -z "$(WINDOWS_SIGNING_SOURCE)" ]; then echo "$(call dev_text,Windows signing directory not found: $(ACHBIT_WINDOWS_SIGNING_DIR),找不到 Windows 签名目录：$(ACHBIT_WINDOWS_SIGNING_DIR))" >&2; exit 1; fi
	@case "$(WINDOWS_SIGNING_SOURCE)/" in "$(ACHBIT_PROJECT_ROOT)/"*) echo '$(call dev_text,Keep the Windows signing profile outside the checkout.,请将 Windows 签名配置放在工作树之外。)' >&2; exit 1;; esac
	@if [ ! -d "$(ACHBIT_PROJECT_ROOT)" ]; then \
		echo "$(call dev_text,[make][error] Project root is unavailable: $(ACHBIT_PROJECT_ROOT),[make][error] 项目根目录不可用: $(ACHBIT_PROJECT_ROOT))" >&2; \
		exit 1; \
	fi
	@if [ -z "$(ACHBIT_RUST_TOOLCHAIN)" ] || [ -z "$(ACHBIT_RUST_VERSION)" ]; then \
		echo "$(call dev_text,[make][error] rust-toolchain.toml has no valid channel,[make][error] rust-toolchain.toml 缺少有效 channel)" >&2; \
		exit 1; \
	fi
	@case "$(ACHBIT_HOST_PORT)" in ''|*[!0-9]*) echo "$(call dev_text,[make][error] ACHBIT_HOST_PORT must be an integer from 1 to 65535,[make][error] ACHBIT_HOST_PORT 必须是 1-65535 的整数)" >&2; exit 1;; esac
	@if [ "$(ACHBIT_HOST_PORT)" -lt 1 ] || [ "$(ACHBIT_HOST_PORT)" -gt 65535 ]; then \
		echo "$(call dev_text,[make][error] ACHBIT_HOST_PORT must be an integer from 1 to 65535,[make][error] ACHBIT_HOST_PORT 必须是 1-65535 的整数)" >&2; \
		exit 1; \
	fi

package-macos:
	@bash ./build.sh --stage package-macos

# Refresh the image from its build inputs before opening a shell.
_print_image:
	@printf '%s\n' '$(IMAGE)'

_ensure_image: _validate_config
	@echo "$(call dev_text,[make] Checking development image $(IMAGE) and reusing cached layers...,[make] 检查开发镜像 $(IMAGE)（变更自动更新，未变化层使用 Docker 缓存）...)"
	@docker build --provenance=false $(BUILD_ARGS) -f $(DOCKERFILE) -t $(IMAGE) .

# Create or resume the development container.
# Container states
#   not exists  -> docker run -d
#   stale       -> recreate when mounts, image, host platform, port or sandbox options change
#   running     -> reuse
#   exited      -> docker start
_ensure_container: _ensure_image
	@if docker container inspect $(CONTAINER_NAME) >/dev/null 2>&1; then \
		mounted_root=$$(docker container inspect -f '{{range .Mounts}}{{if eq .Destination "$(WORKDIR_IN_CTNR)"}}{{.Source}}{{end}}{{end}}' $(CONTAINER_NAME)); \
		signing_source=$$(docker container inspect -f '{{range .Mounts}}{{if eq .Destination "/run/secrets/achbit-windows-signing"}}{{.Source}}{{if .RW}}:rw{{end}}{{end}}{{end}}' $(CONTAINER_NAME)); \
		container_host_os=$$(docker container inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $(CONTAINER_NAME) | sed -n 's/^ACHBIT_BUILD_HOST_OS=//p'); \
		container_image=$$(docker container inspect -f '{{.Image}}' $(CONTAINER_NAME)); \
		current_image=$$(docker image inspect -f '{{.Id}}' $(IMAGE)); \
		actual_host_port=$$(docker container port $(CONTAINER_NAME) $(ACHBIT_CONTAINER_PORT)/tcp 2>/dev/null | awk -F: 'NR == 1 { print $$NF }'); \
		container_caps=$$(docker container inspect -f '{{range .HostConfig.CapAdd}}{{println .}}{{end}}' $(CONTAINER_NAME)); \
		container_security=$$(docker container inspect -f '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' $(CONTAINER_NAME)); \
		container_system_paths=$$(docker container inspect -f '{{len .HostConfig.MaskedPaths}} {{len .HostConfig.ReadonlyPaths}}' $(CONTAINER_NAME)); \
		reason=""; \
		if [ "$$mounted_root" != "$(ACHBIT_PROJECT_ROOT)" ]; then reason="$(call dev_text,Source mount changed,源码挂载已变化)"; \
		elif [ "$$signing_source" != "$(WINDOWS_SIGNING_SOURCE)" ]; then reason="$(call dev_text,Windows signing mount changed,Windows 签名目录挂载已变化)"; \
		elif [ "$$container_image" != "$$current_image" ]; then reason="$(call dev_text,Development image updated,开发镜像已更新)"; \
		elif [ "$$container_host_os" != "$(ACHBIT_BUILD_HOST_OS)" ]; then reason="$(call dev_text,Build host platform changed or is missing,构建宿主平台已变化或缺失)"; \
		elif [ "$$actual_host_port" != "$(ACHBIT_HOST_PORT)" ]; then reason="$(call dev_text,Port configuration changed,端口配置已变化)"; \
		elif ! printf '%s\n' "$$container_caps" | grep -Eq '^(CAP_)?SYS_ADMIN$$' \
			|| ! printf '%s\n' "$$container_security" | grep -Fxq 'apparmor=unconfined' \
			|| ! printf '%s\n' "$$container_security" | grep -Fxq 'seccomp=unconfined' \
			|| [ "$$container_system_paths" != '0 0' ]; then reason="$(call dev_text,Nested Bubblewrap configuration changed,Bubblewrap 嵌套沙箱配置已变化)"; \
		fi; \
		if [ -n "$$reason" ]; then \
			echo "$(call dev_text,[make] $$reason. Recreating $(CONTAINER_NAME) and retaining named volumes...,[make] $${reason}，重建唯一容器 $(CONTAINER_NAME) 并保留 named volumes...)"; \
			docker rm -f $(CONTAINER_NAME) >/dev/null; \
		fi; \
	fi; \
	if ! docker container inspect $(CONTAINER_NAME) >/dev/null 2>&1; then \
		echo "$(call dev_text,[make] Creating and starting $(CONTAINER_NAME)...,[make] 创建并启动唯一容器 $(CONTAINER_NAME)...)"; \
		docker run -d $(RUN_ARGS) $(IMAGE) /usr/local/bin/entrypoint.sh >/dev/null; \
	else \
		status=$$(docker container inspect -f '{{.State.Status}}' $(CONTAINER_NAME) 2>/dev/null | tr -d '[:space:]'); \
		case "$$status" in \
			running) \
				echo "$(call dev_text,[make] Reusing running container $(CONTAINER_NAME),[make] 容器 $(CONTAINER_NAME) 正在运行，直接复用)"; \
				;; \
			exited|created) \
				echo "$(call dev_text,[make] Starting $(CONTAINER_NAME) (state: $$status)...,[make] 容器 $(CONTAINER_NAME) 处于 $$status，start 启动...)"; \
				docker start $(CONTAINER_NAME) >/dev/null ; \
				;; \
			paused) \
				echo "$(call dev_text,[make] Resuming paused container $(CONTAINER_NAME)...,[make] 容器 $(CONTAINER_NAME) 已暂停，unpause 恢复...)"; \
				docker unpause $(CONTAINER_NAME) >/dev/null ; \
				;; \
			dead) \
				echo "$(call dev_text,[make] Recreating stale container $(CONTAINER_NAME) and retaining named volumes...,[make] 容器 $(CONTAINER_NAME) 已失效，精确重建并保留 named volumes...)"; \
				docker rm -f $(CONTAINER_NAME) >/dev/null ; \
				docker run -d $(RUN_ARGS) $(IMAGE) /usr/local/bin/entrypoint.sh >/dev/null ; \
				;; \
			*) \
				echo "$(call dev_text,[make][error] Unsupported container state [$$status]. Run make reset-dev.,[make][error] 不支持的容器状态 [$$status]；请执行 make reset-dev)" >&2; \
				exit 1; \
				;; \
		esac; \
	fi
	@if [ "$(ACHBIT_BUILD_HOST_OS)" = Darwin ]; then python3 scripts/macos-build-bridge.py ensure; fi

# Interactive development shell
shell: _ensure_container
	@echo "$(call dev_text,[make] Opening a shell in $(CONTAINER_NAME)...,[make] exec 进入容器 $(CONTAINER_NAME) ...)"
	@docker exec -it -e ACHBIT_DEV_LANGUAGE $(NETWORK_ENV_ARGS) -e ACHBIT_BUILD_HOST_OS=$(ACHBIT_BUILD_HOST_OS) -e ACHBIT_MACOS_SIGN_IDENTITY -e ACHBIT_WINDOWS_TIMESTAMP_URL $(CONTAINER_NAME) bash

build:
	@bash ./build.sh

package:
	@bash ./build.sh --stage package

ui:
	@bash ./build.sh --stage ui

ui-update:
	@test -n "$(UI_PACKAGE)" || { echo '$(call dev_text,Set UI_PACKAGE to a package directory such as bin/macos-arm64 or bin/win64,请指定 UI_PACKAGE，例如 bin/macos-arm64 或 bin/win64)' >&2; exit 2; }
	@bash ./build.sh --stage ui
	@python3 ./scripts/update-ui.py --package "$(UI_PACKAGE)"

native-gui:
	@bash ./build.sh --stage native-gui

dev-achbit-gui: _ensure_container
	@bash scripts/dev-achbit-gui-host.sh "$(CONTAINER_NAME)" "$(WORKDIR_IN_CTNR)" "$(ACHBIT_CONTAINER_PORT)" $(NETWORK_ENV_ARGS)

# Reset or remove the named development resources for this project.
reset-dev:
	@if [ "$(ACHBIT_BUILD_HOST_OS)" = Darwin ]; then python3 scripts/macos-build-bridge.py stop; fi
	@echo "$(call dev_text,[make] Removing $(CONTAINER_NAME) and retaining dependency and build caches...,[make] 移除唯一开发容器 $(CONTAINER_NAME)，保留依赖与编译缓存 ...)"
	-@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
	@echo "$(call dev_text,[make] Reset complete. The next make shell/build recreates the container.,[make] 重置完成；下次 make shell/build 会按当前源码与镜像重建容器。)"

clean:
	@if [ "$(ACHBIT_BUILD_HOST_OS)" = Darwin ]; then python3 scripts/macos-build-bridge.py stop; fi
	@echo "$(call dev_text,[make] Removing container $(CONTAINER_NAME)...,[make] 强制移除容器 $(CONTAINER_NAME) ...)"
	-@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
	@echo "$(call dev_text,[make] Removing image $(IMAGE)...,[make] 强制移除镜像 $(IMAGE) ...)"
	-@docker rmi -f $(IMAGE) >/dev/null 2>&1 || true
	@echo "$(call dev_text,[make] Removing named volumes...,[make] 移除 named volumes ...)"
	-@for v in $(VOLUMES_ALL); do \
		docker volume rm $$v >/dev/null 2>&1 && echo "$(call dev_text,  - removed volume $$v,  - 已移除卷 $$v)" || echo "$(call dev_text,  - skip $$v (absent),  - skip $$v (不存在))"; \
	done
	@echo "$(call dev_text,[make] Cleanup complete. The next make shell recreates the configured environment.,[make] 清理完成。下次 'make shell' 将重建当前配置需要的容器环境。)"
	@echo "$(call dev_text,[make] Host ./bin and ./node_modules are retained.,[make] 注意：宿主机 ./bin、./node_modules（如存在于宿主端）未被本目标修改。)"

.PHONY: ui-plugin ui-plugin-watch
ui-plugin: _ensure_container
	@docker exec -e ACHBIT_UI_PLUGIN_ROOT="$(WORKDIR_IN_CTNR)/$(UI_PLUGIN)" $(CONTAINER_NAME) pnpm --filter @achbit/client exec vite build --config vite.ui-plugin.config.ts
ui-plugin-watch: _ensure_container
	@docker exec -e ACHBIT_UI_PLUGIN_ROOT="$(WORKDIR_IN_CTNR)/$(UI_PLUGIN)" $(CONTAINER_NAME) pnpm --filter @achbit/client exec vite build --config vite.ui-plugin.config.ts --watch
