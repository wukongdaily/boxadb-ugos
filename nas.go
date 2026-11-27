package main

// 从 NAS 选择安装包（apk / xapk / apkm）。
//
// 绿联 UGOS 的机制：project.yaml 里 allow_add_access_path: true 后，用户可在
// 「应用中心 → 盒子助手 → 设置 → 访问路径」里主动授权文件夹；已授权文件夹会被
// 软链到安装目录的 shared 下（绝对路径见环境变量 UGAPP_SHARED_DIR）。
// 系统没有给 Web 端提供“选择 NAS 文件”的能力（cloudWindow 的 getLocalPath 是 PC only），
// 所以这里由桥只读地列目录，前端自己做选择器。
//
// 端点：
//   GET /nas/list?path=<相对路径>   目录列表（文件只列 apk/xapk/apkm）
//   GET /nas/file?path=<相对路径>   读取文件（支持 Range，交给前端 arrayBuffer 安装）
// 未授权（没有 shared 目录）时返回 ok:false + 引导文案，不报错。

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const nasMaxEntries = 2000

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

var nasExtOK = map[string]bool{".apk": true, ".xapk": true, ".apkm": true}

type nasEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size,omitempty"`
	MTime int64  `json:"mtime,omitempty"`
}

// nasRoot 是一个被授权的文件夹：shared 下的一层条目（通常是软链）
type nasRoot struct {
	Name string // 展示与寻址用的目录名
	Real string // 解析软链后的真实路径
}

func sharedDir() string {
	d := strings.TrimSpace(os.Getenv("UGAPP_SHARED_DIR"))
	if d == "" {
		if inst := os.Getenv("UGAPP_INSTALL_DIR"); inst != "" {
			d = filepath.Join(inst, "shared")
		}
	}
	if d == "" {
		return ""
	}
	if _, err := os.Stat(d); err != nil {
		return ""
	}
	return d
}

// 向导/配置里选的安装包目录（parameters: type path → 环境变量 BOXADB_PKG_DIR）
func paramRoots() []nasRoot {
	p := strings.TrimSpace(os.Getenv("BOXADB_PKG_DIR"))
	if p == "" {
		return nil
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return nil
	}
	st, err := os.Stat(real)
	if err != nil || !st.IsDir() {
		return nil
	}
	return []nasRoot{{Name: filepath.Base(real), Real: real}}
}

// 授权目录集合 = shared 下第一层的目录/软链目录 + 向导里选的安装包目录
// （深层软链不跟随，防止越界）
func nasRoots() []nasRoot {
	shared := sharedDir()
	if shared == "" {
		return dedupeRoots(paramRoots())
	}
	des, err := os.ReadDir(shared)
	if err != nil {
		return nil
	}
	out := []nasRoot{}
	for _, de := range des {
		if strings.HasPrefix(de.Name(), ".") {
			continue
		}
		p := filepath.Join(shared, de.Name())
		real, err := filepath.EvalSymlinks(p)
		if err != nil {
			continue
		}
		st, err := os.Stat(real)
		if err != nil || !st.IsDir() {
			continue
		}
		out = append(out, nasRoot{Name: de.Name(), Real: real})
	}
	out = append(out, paramRoots()...)
	out = dedupeRoots(out)
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

func dedupeRoots(in []nasRoot) []nasRoot {
	seen := map[string]bool{}
	out := make([]nasRoot, 0, len(in))
	for _, r := range in {
		if seen[r.Real] {
			continue
		}
		seen[r.Real] = true
		out = append(out, r)
	}
	return out
}

func within(root, target string) bool {
	if target == root {
		return true
	}
	sep := string(filepath.Separator)
	return strings.HasPrefix(target, strings.TrimSuffix(root, sep)+sep)
}

// resolveNas：以「授权目录名/相对路径」寻址；返回真实路径与命中的授权目录
func resolveNas(rel string) (nasRoot, string, string) {
	rel = strings.TrimPrefix(strings.ReplaceAll(strings.TrimSpace(rel), "\\", "/"), "/")
	if rel == "." {
		rel = ""
	}
	roots := nasRoots()
	if len(roots) == 0 {
		return nasRoot{}, "", "还没有授权可访问的文件夹"
	}
	if rel == "" {
		return nasRoot{}, "", ""
	}
	name, rest := rel, ""
	if i := strings.Index(rel, "/"); i >= 0 {
		name, rest = rel[:i], rel[i+1:]
	}
	var hit *nasRoot
	for i := range roots {
		if roots[i].Name == name {
			hit = &roots[i]
			break
		}
	}
	if hit == nil {
		return nasRoot{}, "", "该目录不是已授权的文件夹"
	}
	if strings.Contains(rest, "..") {
		return *hit, "", "路径不合法"
	}
	cand := hit.Real
	if rest != "" {
		cand = filepath.Join(hit.Real, filepath.FromSlash(rest))
	}
	real, err := filepath.EvalSymlinks(cand)
	if err != nil {
		if os.IsNotExist(err) {
			return *hit, "", "文件或目录不存在（可能已被移动或删除）"
		}
		return *hit, "", "路径不可读：" + err.Error()
	}
	if !within(hit.Real, real) {
		return *hit, "", "该路径不在已授权的文件夹范围内"
	}
	return *hit, real, ""
}

func nasDisabled(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": false, "need": "authorize", "items": []nasEntry{},
		"hint": "没有找到安装包：请打开 控制面板 → 关于本机 → 应用 → 盒子助手 → 配置，新增/修改「可访问文件夹」后保存，再点「重置应用」使其生效（重置会清空应用数据，已配对的盒子需重新配对一次），然后回来点「重新扫描」",
	})
}

// 根层：列出所有已授权文件夹
func nasListRoots(w http.ResponseWriter) {
	roots := nasRoots()
	if len(roots) == 0 {
		nasDisabled(w)
		return
	}
	items := make([]nasEntry, 0, len(roots))
	for _, r := range roots {
		st, _ := os.Stat(r.Real)
		mt := int64(0)
		if st != nil {
			mt = st.ModTime().Unix()
		}
		items = append(items, nasEntry{Name: r.Name, Path: r.Name, Dir: true, MTime: mt})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": "", "items": items})
}

func handleNasList(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	hit, real, errText := resolveNas(rel)
	if errText == "" && rel == "" {
		nasListRoots(w)
		return
	}
	if errText != "" {
		if hit.Name == "" && len(nasRoots()) == 0 {
			nasDisabled(w)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": errText, "items": []nasEntry{}})
		return
	}
	st, err := os.Stat(real)
	if err != nil || !st.IsDir() {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "这不是一个目录", "items": []nasEntry{}})
		return
	}
	des, err := os.ReadDir(real)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": "目录不可读：" + err.Error(), "items": []nasEntry{}})
		return
	}
	items := make([]nasEntry, 0, 64)
	for _, de := range des {
		if len(items) >= nasMaxEntries {
			break
		}
		name := de.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		p := filepath.Join(real, name)
		info, err := de.Info()
		if err != nil {
			continue
		}
		e := nasEntry{Name: name, Path: strings.TrimLeft(rel+"/"+name, "/"), MTime: info.ModTime().Unix()}
		// 目录（含软链目录）必须仍落在授权根内，否则不显示，避免点进去才报错
		if rt, err := os.Stat(p); err == nil && rt.IsDir() {
			real2, e2 := filepath.EvalSymlinks(p)
			if e2 != nil || !within(hit.Real, real2) {
				continue
			}
			e.Dir = true
			e.MTime = rt.ModTime().Unix()
			items = append(items, e)
			continue
		}
		switch {
		case de.IsDir():
			// 目录全部显示：即使读不了也让用户点进去看具体报错，而不是静默消失
			e.Dir = true
		default:
			// 软链目录也当目录显示；普通文件只留安装包
			if rt, err := os.Stat(p); err == nil && rt.IsDir() {
				e.Dir = true
				e.MTime = rt.ModTime().Unix()
			} else if nasExtOK[strings.ToLower(filepath.Ext(name))] {
				e.Size = info.Size()
			} else {
				continue
			}
		}
		items = append(items, e)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Dir != items[j].Dir {
			return items[i].Dir
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": rel, "items": items})
}

func handleNasFile(w http.ResponseWriter, r *http.Request) {
	_, real, errText := resolveNas(r.URL.Query().Get("path"))
	if errText != "" {
		http.Error(w, errText, http.StatusForbidden)
		return
	}
	st, err := os.Stat(real)
	if err != nil || st.IsDir() {
		http.Error(w, "文件不存在", http.StatusNotFound)
		return
	}
	if !nasExtOK[strings.ToLower(filepath.Ext(real))] {
		http.Error(w, "只支持 apk / xapk / apkm", http.StatusForbidden)
		return
	}
	f, err := os.Open(real)
	if err != nil {
		http.Error(w, "文件不可读", http.StatusForbidden)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	http.ServeContent(w, r, filepath.Base(real), st.ModTime().Round(time.Second), f)
}

// handleNasDiag：把「为什么看不到授权目录」的全部判据摊开，避免靠猜排查
func handleNasDiag(w http.ResponseWriter) {
	env := func(k string) string { return os.Getenv(k) }
	shared := sharedDir()
	type item struct {
		Name     string `json:"name"`
		Mode     string `json:"mode,omitempty"`
		Resolved string `json:"resolved,omitempty"`
		Err      string `json:"err,omitempty"`
		IsDir    bool   `json:"isDir"`
	}
	out := []item{}
	if shared != "" {
		des, err := os.ReadDir(shared)
		if err != nil {
			out = append(out, item{Name: "(读取 shared 失败)", Err: err.Error()})
		}
		for _, de := range des {
			p := filepath.Join(shared, de.Name())
			it := item{Name: de.Name()}
			if st, err := os.Lstat(p); err == nil {
				it.Mode = st.Mode().String()
			} else {
				it.Err = "lstat: " + err.Error()
			}
			real, err := filepath.EvalSymlinks(p)
			if err != nil {
				it.Err = strings.TrimSpace(it.Err + " evalsymlink: " + err.Error())
			} else {
				it.Resolved = real
				if st, err := os.Stat(real); err != nil {
					it.Err = strings.TrimSpace(it.Err + " stat: " + err.Error())
				} else {
					it.IsDir = st.IsDir()
				}
			}
			out = append(out, it)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"envUGAPP_SHARED_DIR":  env("UGAPP_SHARED_DIR"),
		"envUGAPP_INSTALL_DIR": env("UGAPP_INSTALL_DIR"),
		"envBOXADB_PKG_DIR":    env("BOXADB_PKG_DIR"),
		"sharedResolved":       shared,
		"entries":              out,
		"roots":                len(nasRoots()),
	})
}

func handleNas(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/nas/diag":
		handleNasDiag(w)
		return true
	case "/nas/list":
		handleNasList(w, r)
	case "/nas/file":
		handleNasFile(w, r)
	default:
		return false
	}
	return true
}
