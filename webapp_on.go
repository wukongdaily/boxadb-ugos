//go:build withwebapp

package main

import (
	"bytes"
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// 带 -tags withwebapp 构建时（Docker / NAS 自托管形态），同一个进程
// 带 -tags withwebapp 构建时（Docker / NAS 自托管）同一个进程既发网页又当桥，
// 同源不再有 https→ws 混合内容限制。webapp/ 由 scripts/make-webapp.sh 生成，不进 git。
//
//go:embed webapp
var webappFS embed.FS

// 自托管标记：运行时注入 index.html，让前端把桥地址切到「同源 + 前缀」。
// 不改 JS 源码：仓库前端与镜像前端字节一致。子路径部署用 BRIDGE_BASE_PATH（如 /boxadb）。
func bridgeMeta() string {
	prefix := os.Getenv("BRIDGE_BASE_PATH")
	return `<meta name="boxadb-mode" content="selfhosted">` +
		`<meta name="boxadb-prefix" content="` + prefix + `">` +
		`<meta name="boxadb-tls-port" content="` + httpsPort() + `">`
}

func staticHandler() http.Handler {
	sub, err := fs.Sub(webappFS, "webapp")
	if err != nil {
		log.Printf("内嵌前端不可用: %v", err)
		return nil
	}
	base := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 不缓存：避免升级后「改了没生效」
		w.Header().Set("Cache-Control", "no-store")
		if p := r.URL.Path; p == "/" || p == "/index.html" {
			if body, ok := withSelfHostedMark(sub, p); ok {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				http.ServeContent(w, r, p, time.Time{}, bytes.NewReader(body))
				return
			}
			log.Printf("警告: index.html 里找不到 <head>，自托管标记未注入，前端会退回连本机桥")
		}
		base.ServeHTTP(w, r)
	})
}

func withSelfHostedMark(fsys fs.FS, name string) ([]byte, bool) {
	raw, err := fs.ReadFile(fsys, "index.html")
	if err != nil {
		return nil, false
	}
	s := string(raw)
	if strings.Contains(s, "boxadb-mode") {
		return raw, true // 源文件已自带标记，直接给
	}
	i := strings.Index(s, "<head")
	if i < 0 {
		return nil, false
	}
	j := strings.IndexByte(s[i:], '>')
	if j < 0 {
		return nil, false
	}
	insertAt := i + j + 1
	meta := bridgeMeta()
	out := make([]byte, 0, len(raw)+len(meta)+1)
	out = append(out, raw[:insertAt]...)
	out = append(out, '\n')
	out = append(out, meta...)
	out = append(out, raw[insertAt:]...)
	return out, true
}

// 服务端形态默认收紧：只允许把隧道打到私网地址（桥能连任意 host:port，
// 防被当内网代理（SSRF）。BRIDGE_PRIVATE_ONLY=0 放开（如经 Tailscale 连远端盒子）。
func privateOnlyDefault() bool { return true }

// 自托管默认开内置 https（8766）：手机需要安全上下文；BRIDGE_HTTPS_PORT=0 可关。
func httpsDefault() string { return "8766" }
