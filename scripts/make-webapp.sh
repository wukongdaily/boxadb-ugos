#!/bin/sh
# 生成 webapp/ —— go:embed 的输入目录。
#
# 前端单一来源是仓库根目录；webapp/ 属构建产物（已 gitignore）。
#
# 不改任何前端内容：自托管标记由桥运行时注入，镜像与仓库字节一致。
#
# POSIX sh + coreutils：构建阶段不需要 apk add（Alpine 源境内常拉不动）。
set -eu

cd "$(dirname "$0")/.."

[ -f index.html ] && [ -d js ] && [ -d css ] || {
  echo "make-webapp: 找不到前端源文件（请在 boxadb 仓库根目录运行）" >&2; exit 1; }

# 前端必须带自托管探测，缺了宁可构建失败也不出静默坏包
grep -qF 'meta[name="boxadb-mode"]' js/tango.js || {
  echo "make-webapp: js/tango.js 里没有 boxadb-mode 自托管探测，请同步改造" >&2; exit 1; }
grep -qF 'meta[name="boxadb-prefix"]' js/tango.js || {
  echo "make-webapp: js/tango.js 里没有 boxadb-prefix 前缀探测" >&2; exit 1; }
grep -qF 'export const BRIDGE_BASE = selfHosted' js/tango.js || {
  echo "make-webapp: BRIDGE_BASE 没有走 selfHosted 分支" >&2; exit 1; }
grep -qF '<head' index.html || {
  echo "make-webapp: index.html 缺 <head>，运行时注入无处可插" >&2; exit 1; }

mkdir -p webapp/assets webapp/css webapp/js

if command -v rsync >/dev/null 2>&1; then
  # 本机：rsync 镜像同步，删掉的源文件不留陈旧副本
  rsync -a index.html webapp/index.html
  rsync -a --delete css/ webapp/css/
  rsync -a --delete js/ webapp/js/
  rsync -a assets/logo.png webapp/assets/logo.png
else
  # 容器：全新目录 + cp，不依赖 rsync
  cp -f index.html webapp/index.html
  for f in css js; do
    for s in $(find "$f" -type f | sort); do
      mkdir -p "webapp/$(dirname "$s")"
      cp -f "$s" "webapp/$s"
    done
  done
  cp -f assets/logo.png webapp/assets/logo.png
fi

# 产物自检：避免半套前端被嵌进二进制
for f in webapp/index.html webapp/js/app.js webapp/js/tango.js webapp/js/vendor/adb.js webapp/css/style.css webapp/assets/logo.png; do
  [ -f "$f" ] || { echo "make-webapp: 缺少 $f" >&2; exit 1; }
done

echo "webapp/ 就绪：$(find webapp -type f | wc -l | tr -d ' ') 个文件"
