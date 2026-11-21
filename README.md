# 盒子助手 · 绿联 UGOS 版 [![bilibili](https://img.shields.io/badge/_B站_·_反馈-A0AABC?style=flat&logo=bilibili&logoColor=fff&labelColor=FB7299&color=3a3a44)](https://www.bilibili.com/video/BV1e4sp6nETW/)

绿联 UGOS Pro 原生应用：**点绿联桌面的「盒子助手」图标 → 打开的就是盒子助手网页**
（经系统加密网关同源访问，局域网里的手机平板也能开）。

## 无线调试（Android 11 及以上）

安卓 11 起的手机 / Google TV / 新盒子，调试端口是随机值、还要配对。绿联版把这件事做进了应用里：

1. 电视上打开 **设置 → 系统 → 开发者选项 → 无线调试**，点 **使用配对码配对设备**
2. 回到盒子助手里点「连接」，选 **连接并固定端口**，把屏幕上的**配对端口**和 **6 位配对码**填进去
3. 配对成功后会自动把端口固定回 **5555**，以后只填 IP 就能连（盒子重启后重开无线调试即可，不用再配对）

老式电视盒子（安卓 9/10，盒子上直接有「网络调试 / ADB 开关」）不需要配对，填 IP 直接连。

## 相关项目

本项目的界面，就是「盒子助手」同一套前端，为绿联 UGOS Pro 做的原生移植——功能一致，按场景二选一：

- **[boxadb（桌面 / 网页版）](https://github.com/wukongdaily/boxadb)** —— 电脑开本地桥，浏览器直接访问 <https://wukongdaily.github.io/boxadb/>，支持 WebUSB 数据线直连。
- **[boxadb-fnos（飞牛版）](https://github.com/wukongdaily/boxadb-fnos)** —— 盒子助手常驻飞牛 NAS，经统一网关同源。
- **boxadb-ugos（本项目 · 绿联版）** —— 盒子助手常驻绿联 NAS，点桌面图标即用，经 UGREENlink 出门在外也能连家里盒子。

## 安装

上架后可在 **绿联应用中心** 搜索「盒子助手」一键安装（应用以原生应用形式运行，无需 Docker、无需命令行）。

## 第三方组件致谢

- **[@yume-chan/ya-webadb (Tango)](https://github.com/yume-chan/ya-webadb)** —— ADB 协议引擎（Simon Chan），MIT
- **[xterm.js](https://xtermjs.org/)** —— 浏览器终端，MIT
- **[fflate](https://github.com/101arrowz/fflate)** —— APK/XAPK 解包，MIT
- **[Node.js](https://nodejs.org/)** —— 无线调试配对运行时（与飞牛 / Docker 版同一份配对模块），MIT（许可全文见 [`LICENSE-node.txt`](LICENSE-node.txt)）

其余第三方版权声明与许可全文见 [`boxadb 仓库 www/js/vendor/THIRD-PARTY-LICENSES.md`](https://github.com/wukongdaily/boxadb/blob/main/js/vendor/THIRD-PARTY-LICENSES.md)。

## 许可

[MIT](LICENSE)
