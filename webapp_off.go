//go:build !withwebapp

package main

import "net/http"

// 默认构建 = 桌面版本机桥：不带前端、不对外监听、行为与既往完全一致。
func staticHandler() http.Handler { return nil }

// 桌面形态默认不限制目标网段：本机自用，且避免升级后突然连不上。
func privateOnlyDefault() bool { return false }

// 桌面默认不开 https：Pages 本来就是 https，桥只需回环明文 ws（要开用 BRIDGE_HTTPS_PORT）。
func httpsDefault() string { return "0" }
