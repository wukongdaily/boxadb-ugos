#!/bin/sh
# boxadb-ugos 一键构建：拉主仓源码 → 应用 UGOS 补丁 → 交叉编译 → 出 UPK
#
# 依赖：git、go (>=1.21)、curl、tar、ugcli (https://developer.ugnas.com/doc/tools/ugcli.html)
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

# 3. 配对模块：主仓 pair/ 是唯一真源，构建时拷进来（本仓不重复存一份）
mkdir -p "${REPO_ROOT}/rootfs_common/pair"
cp -f "${SRC}/pair/"*.js "${REPO_ROOT}/rootfs_common/pair/"

# 3b. Node 运行时：121MB 超 GitHub 单文件限制，不入 git，构建时下载并校验
NODE_VER="v24.22.3"
NODE_SHA="4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb"
NODE_TGZ="${WORK}/node-${NODE_VER}-linux-x64.tar.xz"
if [ ! -x "${REPO_ROOT}/rootfs_amd64/bin/node" ]; then
  if [ ! -f "${NODE_TGZ}" ]; then
    curl -fL --retry 3 -o "${NODE_TGZ}" \
      "https://nodejs.org/dist/latest-v24.x/node-${NODE_VER}-linux-x64.tar.xz"
  fi
  echo "${NODE_SHA}  ${NODE_TGZ}" | shasum -a 256 -c - || {
    echo "Node 包校验失败，终止"; exit 1; }
  tar -xJf "${NODE_TGZ}" -C "${WORK}"
  mkdir -p "${REPO_ROOT}/rootfs_amd64/bin"
  cp "${WORK}/node-${NODE_VER}-linux-x64/bin/node" "${REPO_ROOT}/rootfs_amd64/bin/node"
  chmod 0755 "${REPO_ROOT}/rootfs_amd64/bin/node"
fi

# 4. 生成嵌入前端 + 交叉编译（amd64；arm64 暂缓）
cd "${SRC}"
sh scripts/make-webapp.sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -tags withwebapp -trimpath -ldflags='-s -w' \
  -o "${REPO_ROOT}/rootfs_amd64/bin/boxadb-bridge" .
chmod 0755 "${REPO_ROOT}/rootfs_amd64/bin/boxadb-bridge"

# 5. 校验 + 打包（amd64 / nasync）
cd "${REPO_ROOT}"
ugcli check
BUILD="${1:-1}"
ugcli pack --arch amd64 --product-series nasync --build "${BUILD}"

echo
echo "产物："
ls -l "${UPK_OUT}"/*.upk | tail -2
