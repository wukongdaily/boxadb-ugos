#!/bin/sh
# boxadb-ugos 一键构建：编译 Go 桥（amd64+arm64）→ 下载 Node → 拷 pair/ → ugcli check + pack
#
# 依赖：go (>=1.21)、curl、tar、ugcli (https://developer.ugnas.com/doc/tools/ugcli.html)
# 源码就在本仓：Go + 前端 + pair/ 全在这里，不需要拉任何外部仓库。
set -eu

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
WORK="${REPO_ROOT}/.work"
mkdir -p "${WORK}"

# 1. 生成嵌入前端（webapp/ 由 index.html + js/ + css/ 组成）
sh scripts/make-webapp.sh

# 2. 交叉编译 Go 桥（amd64 + arm64）
for ARCH in amd64 arm64; do
  export CGO_ENABLED=0 GOOS=linux GOARCH="${ARCH}"
  go build -tags withwebapp -trimpath -ldflags='-s -w' \
    -o "${REPO_ROOT}/rootfs_${ARCH}/bin/boxadb-bridge" .
  chmod 0755 "${REPO_ROOT}/rootfs_${ARCH}/bin/boxadb-bridge"
  echo "bridge ${ARCH} built"
done

# 3. 拷 pair/ 到 rootfs_common（sidecar 从这里读脚本）
mkdir -p "${REPO_ROOT}/rootfs_common/pair"
cp -f "${REPO_ROOT}/pair/"*.js "${REPO_ROOT}/rootfs_common/pair/"

# 4. Node 运行时：>100MB 超 GitHub 单文件限制，不入 git，构建时下载并校验
NODE_VER="v24.22.3"
NODE_SHA_AMD64="4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb"
NODE_SHA_ARM64="6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c"

download_node() {
  local arch="$1" sha="$2"
  # Go 叫 amd64，Node 叫 x64；arm64 两边一致
  local node_arch="$arch"
  [ "${arch}" = "amd64" ] && node_arch="x64"
  local tgz="${WORK}/node-${NODE_VER}-linux-${node_arch}.tar.xz"
  local dst="${REPO_ROOT}/rootfs_${arch}/bin/node"
  [ -x "${dst}" ] && return 0
  if [ ! -f "${tgz}" ]; then
    curl -fL --retry 3 -o "${tgz}" \
      "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-${node_arch}.tar.xz"
  fi
  echo "${sha}  ${tgz}" | shasum -a 256 -c - || { echo "Node ${arch} 校验失败"; exit 1; }
  tar -xJf "${tgz}" -C "${WORK}"
  mkdir -p "${REPO_ROOT}/rootfs_${arch}/bin"
  cp "${WORK}/node-${NODE_VER}-linux-${node_arch}/bin/node" "${dst}"
  chmod 0755 "${dst}"
  echo "node ${arch} installed"
}

download_node amd64 "${NODE_SHA_AMD64}"
download_node arm64 "${NODE_SHA_ARM64}"

# 5. 校验 + 打包（amd64 + arm64 / nasync）
cd "${REPO_ROOT}"
ugcli check
BUILD="${1:-1}"
ugcli pack --arch amd64 --product-series nasync --build "${BUILD}"
ugcli pack --arch arm64 --product-series nasync --build "${BUILD}"

echo
echo "产物："
ls -l "${REPO_ROOT}/build_dir/pkgs/upk/"*"_0."*".upk" 2>/dev/null | tail -4
