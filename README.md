# boxadb-ugos

「盒子助手」(BoxADB) 的绿联 UGOS Pro **原生应用**打包工程。主仓（前端 + Go 桥源码）在 [wukongdaily/boxadb](https://github.com/wukongdaily/boxadb)，本仓只负责 UGOS 打包与平台适配。

## 已验证结论（DX4600 Pro 真机，UGOS Pro）

- ✅ 系统反代透传 WebSocket upgrade（ADB 隧道可用）
- ✅ 系统 https 网关提供安全上下文（crypto.subtle 可用，无需自签证书）
- ✅ `NETWORK.ACCESS_INTERNET` 权限下桥可出站连盒子 5555
- ✅ `open_type: inner` 桌面独立窗口，UGREENlink 远程免配置可用
- ✅ macOS 版 ugcli 打包即够用（无需 Debian 12）

## 目录

```
project.yaml                  # UGOS 应用清单（app_id / 端口 / proxy_path / open_type）
rootfs_amd64/bin/boxadb-bridge  # Go 桥（静态二进制，含内嵌前端）
rootfs_arm64/bin/             # arm64 暂缓（尚无可测机型），结构占位
rootfs_common/icon.png        # 应用图标 256×256
rootfs_common/www/index.html  # 入口引导页（跳 /boxadb/，真正界面由桥经反代提供）
scripts/build.sh              # 一键构建（拉主仓 + 补丁 + 交叉编译 + ugcli pack）
scripts/ugos.patch            # 主仓相对上游的 UGOS 支持改动
screenshot/                   # 截图存放目录
```

## 安装（手动装 UPK）

1. 应用中心 → 手动安装 → 选 `amd64_nasync_com.wukongdaily.boxadb_x.y.z.b.upk`
2. 非官方包需设备开发者授权：`ugdev.sig` 放管理员个人文件夹根目录（有效期 1 年；固件 ≥ 1.16 还需在「应用中心 > 设置 > 应用开发设置」点整机授权）
3. UGOS 桌面点「盒子助手」图标即可使用

## 构建

```sh
sh scripts/build.sh 1     # 参数为 build 号
```

产物在 `build_dir/pkgs/upk/`。仅出 amd64（arm64 等有机型再恢复）。

## 架构要点（绿联版特有）

- 路线 A：`open_type: inner` + 系统 https 网关，**桥跑纯 http + WS**（内置 TLS 关闭）
- 桥检测 `UGAPP_*` 环境变量自动进 UGOS 形态：`0.0.0.0:21010`、前缀 `/boxadb`、https 关
- router 兼容网关「剥/不剥」`/boxadb` 前缀两种转发方式
- 出站连盒子依赖 `permissions: NETWORK.ACCESS_INTERNET`（缺了会 Dial 失败）
- 应用以非 root 独立用户运行，数据落 `UGAPP_DATA_DIR`，SIGTERM 10 秒内优雅退出
