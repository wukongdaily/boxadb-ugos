// 内置自签 HTTPS：浏览器只在安全上下文里开放 WebCrypto，
// http://局域网IP 不算安全上下文，没它手机就生成不了 ADB 密钥。
//
// 只用标准库（crypto/tls + crypto/x509）；SAN 覆盖本机网卡地址 + 主机名 + localhost。
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 端口为 "0"/"off"/空 表示关闭 https（纯 http 形态）
func httpsPort() string {
	p := os.Getenv("BRIDGE_HTTPS_PORT")
	if p == "" {
		p = httpsDefault() // 桌面版默认关（不多开端口），自托管版默认开（手机才可用）
	}
	if p == "0" || strings.EqualFold(p, "off") {
		return ""
	}
	return p
}

// 证书落盘目录：挂卷即可持久，重启不换证书
func tlsStateDir() string { return os.Getenv("BRIDGE_STATE_DIR") }

func tlsExtraHosts() []string {
	v := os.Getenv("BRIDGE_TLS_HOSTS")
	if v == "" {
		return nil
	}
	var out []string
	for _, h := range strings.Split(v, ",") {
		if h = strings.TrimSpace(h); h != "" {
			out = append(out, h)
		}
	}
	return out
}

// 本机所有可用地址 + 名字，全部塞进证书 SAN
func discoverHosts() (ips []net.IP, names []string) {
	seenIP := map[string]bool{}
	seenName := map[string]bool{}
	add := func(ip net.IP) {
		if ip == nil {
			return
		}
		k := ip.String()
		if !seenIP[k] {
			seenIP[k] = true
			ips = append(ips, ip)
		}
	}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok {
				add(n.IP)
			}
		}
	}
	add(net.ParseIP("127.0.0.1"))
	add(net.ParseIP("::1"))

	for _, n := range []string{"localhost"} {
		seenName[n] = true
		names = append(names, n)
	}
	if h, err := os.Hostname(); err == nil && h != "" && !seenName[h] {
		seenName[h] = true
		names = append(names, h)
	}
	for _, h := range tlsExtraHosts() {
		if ip := net.ParseIP(h); ip != nil {
			add(ip)
		} else if !seenName[h] {
			seenName[h] = true
			names = append(names, h)
		}
	}
	sort.Slice(ips, func(i, j int) bool { return ips[i].String() < ips[j].String() })
	sort.Strings(names)
	return ips, names
}

func makeSelfSigned(ips []net.IP, names []string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	sn, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: sn,
		Subject:      pkix.Name{CommonName: "BoxADB 局域网自签证书", Organization: []string{"BoxADB"}},
		NotBefore:    now.Add(-time.Hour),
		// 825 天：浏览器对自签证书接受度的安全范围
		NotAfter:              now.AddDate(2, 3, 15),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IPAddresses:           ips,
		DNSNames:              names,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	c, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, err
	}
	if dir := tlsStateDir(); dir != "" {
		if err := saveCert(dir, certPEM, keyPEM); err != nil {
			log.Printf("证书无法持久化（%v）——本次仅内存使用，重启后会换一张证书、需重新点「继续访问」", err)
		} else {
			log.Printf("自签证书已存到 %s（重启不换证书）", dir)
		}
	}
	return c, nil
}

func saveCert(dir string, certPEM, keyPEM []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "tls.crt"), certPEM, 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "tls.key"), keyPEM, 0o600)
}

func loadCert(dir string) (tls.Certificate, bool) {
	certFile, keyFile := filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key")
	if _, err := os.Stat(certFile); err != nil {
		return tls.Certificate{}, false
	}
	if _, err := os.Stat(keyFile); err != nil {
		return tls.Certificate{}, false
	}
	c, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		log.Printf("已存证书读取失败（%v），将重新生成", err)
		return tls.Certificate{}, false
	}
	if len(c.Certificate) == 0 {
		return tls.Certificate{}, false
	}
	leaf, err := x509.ParseCertificate(c.Certificate[0])
	if err != nil || time.Now().After(leaf.NotAfter) {
		log.Printf("已存证书过期或损坏，将重新生成")
		return tls.Certificate{}, false
	}
	// 网卡/额外主机变了就重签，否则新加的 IP 还是点不开
	ips, names := discoverHosts()
	if !sanCovers(leaf, ips, names) {
		log.Printf("已存证书的 SAN 不覆盖当前地址，重新签发")
		return tls.Certificate{}, false
	}
	return c, true
}

func sanCovers(leaf *x509.Certificate, ips []net.IP, names []string) bool {
	haveIP := map[string]bool{}
	for _, ip := range leaf.IPAddresses {
		haveIP[ip.String()] = true
	}
	for _, ip := range ips {
		if !haveIP[ip.String()] {
			return false
		}
	}
	haveName := map[string]bool{}
	for _, n := range leaf.DNSNames {
		haveName[n] = true
	}
	for _, n := range names {
		if !haveName[n] {
			return false
		}
	}
	return true
}

var (
	certOnce tls.Certificate
	certOK   bool
	certDone bool
)

// bridgeTLSConfig 取证书（首次调用时加载或生成，之后复用）
func bridgeTLSConfig() (*tls.Config, error) {
	if !certDone {
		dir := tlsStateDir()
		if dir != "" {
			if c, ok := loadCert(dir); ok {
				certOnce, certOK = c, true
				log.Printf("复用已存自签证书（指纹 %s）", certFingerprint(c))
			}
		}
		if !certOK {
			ips, names := discoverHosts()
			c, err := makeSelfSigned(ips, names)
			if err != nil {
				return nil, err
			}
			certOnce, certOK = c, true
			log.Printf("自签证书已签发（指纹 %s，覆盖 %d 个地址 + %d 个名字）",
				certFingerprint(c), len(ips), len(names))
		}
		certDone = true
	}
	if !certOK {
		return nil, errors.New("自签证书不可用")
	}
	return &tls.Config{
		Certificates: []tls.Certificate{certOnce},
		MinVersion:   tls.VersionTLS12,
	}, nil
}

func certFingerprint(c tls.Certificate) string {
	if len(c.Certificate) == 0 {
		return "?"
	}
	sum := sha256.Sum256(c.Certificate[0])
	return hex.EncodeToString(sum[:6])
}

// http 侧把非本机地址的页面请求跳到 https
// localhost、/health、/adb 不跳：SSH 转发本来就是安全上下文，探针与隧道要能直连
func httpsRedirectHost(r *http.Request) string {
	if httpsPort() == "" {
		return ""
	}
	if r.URL.Path == "/health" || r.URL.Path == "/adb" || r.Method == http.MethodOptions {
		return ""
	}
	if r.Header.Get("X-Forwarded-Proto") == "https" {
		return ""
	}
	h := r.Host
	if i := strings.LastIndex(h, ":"); i > 0 && !strings.Contains(h[i:], "]") {
		h = h[:i]
	}
	h = strings.Trim(h, "[]")
	if h == "" || h == "localhost" {
		return ""
	}
	if ip := net.ParseIP(h); ip != nil && ip.IsLoopback() {
		return ""
	}
	return h
}

func redirectTarget(r *http.Request, host string) string {
	u := "https://" + net.JoinHostPort(host, httpsPort()) + r.URL.Path
	if q := r.URL.RawQuery; q != "" {
		u += "?" + q
	}
	return u
}

// 日志里提示的访问地址：优先取非回环 IPv4
// 容器/NAS 上常有 docker0、br-* 这些 172.16/12 地址，把它们排到最后，
// 否则日志会建议一个用户根本打不开的地址。
func lanRank(v4 net.IP) int {
	oct := v4[0]
	switch {
	case v4.IsLoopback() || v4.IsLinkLocalUnicast():
		return 9
	case oct == 192 && v4[1] == 168:
		return 0 // 家庭/办公局域网最常见
	case oct == 10:
		return 1
	case oct == 172 && v4[1] >= 16 && v4[1] <= 31:
		return 3 // Docker / 网桥段
	case v4.IsPrivate():
		return 2
	default:
		return 8
	}
}

// 虚拟网卡（vmnet/veth/br-/docker/utun…）排后，避免建议一个用户打不开的地址
func ifaceNameRank(name string) int {
	n := strings.ToLower(name)
	for _, bad := range []string{"vmnet", "veth", "br-", "br", "docker", "virbr", "tun", "tap", "utun", "awdl", "llw", "bridge", "wg", "cni", "flannel", "kube", "lo"} {
		if strings.HasPrefix(n, bad) {
			return 1
		}
	}
	return 0
}

func lanHintIP() net.IP {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var best net.IP
	bestScore := 1 << 30
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			v4 := ipn.IP.To4()
			if v4 == nil {
				continue
			}
			if score := lanRank(v4)*4 + ifaceNameRank(ifc.Name); score < bestScore {
				bestScore, best = score, v4
			}
		}
	}
	return best
}

func httpsURLHint() string {
	p := httpsPort()
	if p == "" {
		return ""
	}
	if ip := lanHintIP(); ip != nil {
		return "https://" + net.JoinHostPort(ip.String(), p) + "/"
	}
	ips, _ := discoverHosts()
	best, bestRank := net.IP(nil), 10
	for _, ip := range ips {
		v4 := ip.To4()
		if v4 == nil {
			continue
		}
		if r := lanRank(v4); r < bestRank {
			best, bestRank = v4, r
		}
	}
	if best == nil || bestRank >= 9 {
		return "https://<本机IP>:" + p + "/"
	}
	return "https://" + net.JoinHostPort(best.String(), p) + "/"
}

func serveHTTPS(Handler http.Handler, stop <-chan struct{}) {
	p := httpsPort()
	if p == "" {
		return
	}
	cfg, err := bridgeTLSConfig()
	if err != nil {
		log.Printf("https 未启用: %v", err)
		return
	}
	ln, err := tls.Listen("tcp", net.JoinHostPort(listenHost(), p), cfg)
	if err != nil {
		log.Printf("https 监听失败（端口 %s 被占？）: %v", p, err)
		return
	}
	srv := &http.Server{
		Addr:              net.JoinHostPort(listenHost(), p),
		Handler:           Handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-stop
		srv.Close()
		ln.Close()
	}()
	log.Printf("https 已监听 %s（首次访问点「高级 → 继续访问」，之后长期有效）", srv.Addr)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Printf("https 服务退出: %v", err)
	}
}
