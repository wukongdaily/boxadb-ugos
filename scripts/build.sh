#!/bin/sh
# boxadb-ugos 一键构建：拉主仓源码 → 应用 UGOS 补丁 → 交叉编译 → 出 UPK
#
# 依赖：git、go (>=1.21)、ugcli (https://developer.ugnas.com/doc/tools/ugcli.html)
# 说明：scripts/ugos.patch 是 boxadb 主仓相对上游的 UGOS 支持改动；
#       待主仓正式提交这些改动后，本脚本里的 applypatch 步骤会自动变成空操作（可安全保留）。
set -eu

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
WORK="${REPO_ROOT}/.work"
SRC="${WORK}/boxadb"
UPK_OUT="${REPO_ROOT}/build_dir/pkgs/upk"

mkdir -p "${WORK}"

# 1. 拉主仓（已有则更新）
if [ -d "${SRC}/.git" ]; then
  git -C "${SRC}" pull --ff-only
else
  git clone --depth 1 https://github.com/wukongdaily/boxadb.git "${SRC}"
fi

# 2. 应用 UGOS 补丁（幂等：已应用过则跳过）
if ! grep -q 'ugosMode' "${SRC}/bridge.go" 2>/dev/null; then
  git -C "${SRC}" apply "${REPO_ROOT}/scripts/ugos.patch"
  echo "已应用 scripts/ugos.patch"
else
  echo "主仓已包含 UGOS 支持，跳过补丁"
fi

# 3. 生成嵌入前端 + 交叉编译（amd64；arm64 暂缓）
cd "${SRC}"
sh scripts/make-webapp.sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -tags withwebapp -trimpath -ldflags='-s -w' \
  -o "${REPO_ROOT}/rootfs_amd64/bin/boxadb-bridge" .
chmod 0755 "${REPO_ROOT}/rootfs_amd64/bin/boxadb-bridge"

# 4. 校验 + 打包（amd64 / nasync）
cd "${REPO_ROOT}"
ugcli check
BUILD="${1:-1}"
ugcli pack --arch amd64 --product-series nasync --build "${BUILD}"

echo
echo "产物："
ls -l "${UPK_OUT}"/*.upk | tail -2
