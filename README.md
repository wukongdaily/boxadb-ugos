# 盒子助手 · 绿联 UGOS 版 [![bilibili](https://img.shields.io/badge/_B站_·_反馈-A0AABC?style=flat&logo=bilibili&logoColor=fff&labelColor=FB7299&color=3a3a44)](https://www.bilibili.com/video/BV1e4sp6nETW/)

绿联 UGOS Pro 原生应用：**点绿联桌面的「盒子助手」图标 → 打开的就是盒子助手网页**
（经系统加密网关同源访问，局域网里的手机平板也能开）。

## 截图

<!-- TODO: 截图放入 screenshot/ 目录后在此引用 -->
<p align="center">
  <img src="screenshot/README-1.png" width="420" alt="盒子助手 UGOS 版">
</p>

## 相关项目

本项目的界面，就是「盒子助手」同一套前端，为绿联 UGOS Pro 做的原生移植——功能一致，按场景二选一：

- **[boxadb（桌面 / 网页版）](https://github.com/wukongdaily/boxadb)** —— 电脑开本地桥，浏览器直接访问 <https://wukongdaily.github.io/boxadb/>，支持 WebUSB 数据线直连。
- **[boxadb-fnos（飞牛版）](https://github.com/wukongdaily/boxadb-fnos)** —— 盒子助手常驻飞牛 NAS，经统一网关同源。
- **boxadb-ugos（本项目 · 绿联版）** —— 盒子助手常驻绿联 NAS，点桌面图标即用，经 UGREENlink 出门在外也能连家里盒子。

## 安装

上架后可在 **绿联应用中心** 搜索「盒子助手」一键安装（应用以原生应用形式运行，无需 Docker、无需命令行）。

## 第三方组件致谢（均为 MIT）

- **[@yume-chan/ya-webadb (Tango)](https://github.com/yume-chan/ya-webadb)** —— ADB 协议引擎（Simon Chan）
- **[xterm.js](https://xtermjs.org/)** —— 浏览器终端
- **[fflate](https://github.com/101arrowz/fflate)** —— APK/XAPK 解包

版权声明与许可全文见 [`boxadb 仓库 www/js/vendor/THIRD-PARTY-LICENSES.md`](https://github.com/wukongdaily/boxadb/blob/main/js/vendor/THIRD-PARTY-LICENSES.md)。

## 许可

[MIT](LICENSE)
