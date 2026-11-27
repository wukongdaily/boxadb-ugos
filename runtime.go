package main

// 桌面随包 Node 运行时。
//
// 配对协议要求 TLS 1.3 外部 PSK + exportKeyingMaterial，Go 标准库 crypto/tls 不支持，
// 所以配对统一由 Node 跑主仓 pair/（与 Docker/容器形态同一实现）。桌面版用户机器上
// 没有 Node，发版前由 scripts/fetch-node.sh 把官方 node 二进制 gzip 后放进
// embedded/（按 GOOS-GOARCH 命名），编译进 exe；运行时释放到数据目录再启动 sidecar。
//
// 释放目录以「内容哈希」命名：exe 升级后自动换目录重新释放，不会出现桥升级了
// 释放出来的配对脚本还是旧的。embedded/ 里没有本平台 .gz 时（clone 源码直接构建、
// scratch 镜像等）整条路径返回 nil，行为与既往桌面版一致：配对入口隐藏。

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

//go:embed all:embedded
var embeddedFS embed.FS

//go:embed pair/*.js
var embeddedPairFS embed.FS

// 桌面 sidecar 默认监听端口：8765 是主桥，8766 是内置 https
const desktopPairPort = "8767"

func bundledRuntime() *pairRuntime {
	name := "node-" + runtime.GOOS + "-" + runtime.GOARCH + ".gz"
	archive, err := embeddedFS.ReadFile("embedded/" + name)
	if err != nil || len(archive) == 0 {
		return nil
	}
	tag := bundledTag(archive)
	dir := filepath.Join(dataDir(), "runtime", tag)

	nodeBin := filepath.Join(dir, "node")
	if runtime.GOOS == "windows" {
		nodeBin += ".exe"
	}
	if err := extractNode(dir, archive, nodeBin); err != nil {
		log.Printf("随包 Node 释放失败 %v，配对能力关闭", err)
		return nil
	}
	pairDir := filepath.Join(dir, "pair")
	if err := extractPair(pairDir); err != nil {
		log.Printf("配对脚本释放失败 %v，配对能力关闭", err)
		return nil
	}
	port := strings.TrimSpace(os.Getenv("BOXADB_PAIR_PORT"))
	if port == "" {
		port = desktopPairPort
	}
	return &pairRuntime{
		node:     nodeBin,
		script:   filepath.Join(pairDir, "daemon.js"),
		port:     port,
		stateDir: filepath.Join(dataDir(), "pair"),
		logFile:  filepath.Join(dataDir(), "pair.log"), // 桌面排障就靠它（sidecar 日志与桥控制台分流）
	}
}

// bundledTag：node 归档 + 配对脚本的联合内容哈希，作为释放目录名。
func bundledTag(nodeArchive []byte) string {
	nh := sha256.Sum256(nodeArchive)
	ph := sha256.New()
	_ = fs.WalkDir(embeddedPairFS, "pair", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := embeddedPairFS.ReadFile(p)
		if err != nil {
			return err
		}
		ph.Write([]byte(p))
		ph.Write(b)
		return nil
	})
	return hex.EncodeToString(nh[:6]) + "-" + hex.EncodeToString(ph.Sum(nil)[:6])
}

func extractNode(dir string, archive []byte, nodeBin string) error {
	if st, err := os.Stat(nodeBin); err == nil && st.Size() > 0 {
		return nil // 目录名即内容哈希，存在即同一版本
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, "node.gz.tmp")
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	zr, err := gzip.NewReader(bytes.NewReader(archive))
	if err == nil {
		_, err = io.Copy(f, zr)
		_ = zr.Close()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, nodeBin); err != nil {
		_ = os.Remove(tmp)
		// 并发双击：另一个进程已抢先释放好，认它
		if st, e := os.Stat(nodeBin); e == nil && st.Size() > 0 {
			return nil
		}
		return err
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(nodeBin, 0o755)
	}
	log.Printf("随包 Node 已释放到 %s（首次一次，之后复用）", nodeBin)
	return nil
}

// extractPair：脚本很小（13 个 js），每次启动按内嵌内容重写，保证与当前 exe 一致。
func extractPair(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return fs.WalkDir(embeddedPairFS, "pair", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := embeddedPairFS.ReadFile(p)
		if err != nil {
			return err
		}
		dst := filepath.Join(dir, filepath.Base(p))
		return os.WriteFile(dst, b, 0o644)
	})
}
