# MS2133 WebHID Flasher

基于浏览器 WebHID 的 MS2133 固件备份、恢复与指定文件刷写工具。可直接使用 HTTPS 在线页面，也可通过 Go 启动器在 `127.0.0.1` 打开静态网页。设备通信由桌面 Chrome / Edge 完成，无需安装原生 USB 驱动后端。

**源码仓库和源码包不分发任何固件或设备备份。** 固件由使用者从本机选择，不提供厂商镜像、预置实验固件或下载固件脚本。文件在浏览器本机处理，不上传到 GitHub Pages 或本地静态启动器。

A browser-based MS2133 firmware backup and flashing tool. Use the HTTPS site or the local static launcher. No firmware images are distributed or uploaded.

## 在线使用

在线入口：[MS2133 WebHID Flasher](https://cryomachine.github.io/ms2133-webhid-flasher/)。

1. 使用桌面 Chrome / Edge 打开在线入口。HTTPS 满足 WebHID 的安全上下文要求，无需启动 Go 服务。
2. 点击“连接采集卡”，在浏览器的设备授权对话框中选择采集卡。页面只列出已获授权的设备；首次访问在线页需要在该来源重新授权。
3. 按[使用流程](#使用流程)先备份，再从本机选择自己的备份或固件。在线站点只提供静态网页，固件、设备备份和恢复包均在本机处理。

浏览器设备授权及 IndexedDB / localStorage 持久记录按 **origin（协议、主机、端口）** 隔离，而非按仓库路径隔离。Pages 使用 `https://cryomachine.github.io`，本地启动器使用 `http://127.0.0.1:17333`，开发页使用 `http://127.0.0.1:1430`；三者的授权和记录互不共享。在 Pages 与 localhost 之间切换时，需要重新授权设备并导入磁盘备份。更换浏览器或清除站点数据也可能清除授权或本机记录。

## 功能与边界

| 功能 | 行为 |
| --- | --- |
| 备份当前固件 | 识别受支持接口和 Flash 容量，完整读取两遍并逐字节比对后保存 |
| 恢复自己的备份 | 从本机文件或浏览器已存备份中提取、校验启动容器 |
| 刷写指定固件 | 校验容器、保存当前备份、写前复核，只修改发生变化的扇区 |
| 写后验证 | 每个扇区回读，再核对完整 Flash 与保留尾区 |
| 操作恢复信息 | 在本机浏览器保存备份、操作状态和日志，可导出恢复包 |

当前写入格式为 98,356 字节（`0x18034`）的 MS2133 启动容器。恢复完整 Flash 备份时只提取启动容器，保留目标设备当前尾区，不做整片备份覆盖。

仅对通过代码能力探测的接口开放操作。ROM 接口的写入事务尚未验证，保持禁用；设备可枚举并不代表能够恢复，普通 HID 完全失联时不保证可救砖。写后回读通过也不等于已经完成断电重启后的功能验证。

## 环境

- 桌面 Chrome / Edge，且浏览器提供 WebHID；Safari、Firefox 和移动浏览器不支持此流程。
- WebHID 页面须运行在 HTTPS 或 localhost 安全上下文；不能直接用 `file://` 打开构建产物。
- 源码构建需要 Node.js 22+、npm、Python 3 和 Go 1.22+。
- 启动器可构建为 macOS arm64 / amd64、Windows amd64、Linux amd64 / arm64；Linux 可能需要配置 HID 设备权限。交叉编译成功不代表所有硬件和平台组合均已验证。

## 构建与启动

在项目根目录执行：

```sh
npm ci
npm run check:source
npm test
npm run build
mkdir -p build
go build -trimpath -o build/ms2133-flasher .
./build/ms2133-flasher
```

Windows 可将输出文件名改为 `build/ms2133-flasher.exe`。启动器默认打开 `http://127.0.0.1:17333/`；若自动打开失败，将地址复制到 Chrome / Edge。

```sh
./build/ms2133-flasher -port 17335
./build/ms2133-flasher -no-browser
```

`-port 0` 可自动分配空闲端口，实际地址显示在终端。关闭网页不会停止服务，终端按 Ctrl+C 退出。再次启动会尝试复用已有服务；更换版本前先完成操作并退出旧服务。

构建全部启动器：

```sh
sh build-launchers.sh
```

输出位于 `release/`，macOS 应用为本地未签名构建。构建脚本不会添加固件。

## 使用流程

1. 接入采集卡，打开在线或本地页面，点击“连接采集卡”，在浏览器对话框中选择设备。
2. 核对设备状态。先选择“备份当前固件”，等待双遍读取一致，将完整备份另存到磁盘。
3. 恢复时选择自己的备份文件，或使用“本机已存备份”；刷写时选择自己的固件容器。核对文件检查结果和目标设备后开始。
4. 写入前必须完成当前设备备份保存。点击“下载备份”，确认文件保存后按页面提示继续；普通下载路径还需要点击“已保存备份，继续”。保存门槛通过前不会擦除。
5. 等待擦写与完整回读验证结束，以验证结果判断成功。首次擦除前可取消，擦除开始后取消锁定。过程中不要拔出设备或关闭页面。

恢复包 JSON 用于保存备份和操作信息，不是可直接刷写的固件文件。浏览器记录受上述 origin 隔离与站点数据清理影响，磁盘备份应独立保留。

中断后不会自动续写或重复擦除。重新连接并根据实际可用接口处理恢复；需要切换固件枚举模式时，可能须断开 USB、HDMI 等全部供电后重连。

## 开发与检查

```sh
npm run dev
```

开发地址为 `http://127.0.0.1:1430/`。真实写入使用已部署的静态在线页面，或嵌入已构建静态资源的 Go 启动器，避免开发热更新中断操作。

`npm test` 使用离线 mock，不枚举或写入真实设备，也不能覆盖硬件断连、掉电或全部固件版本。CI 执行源码无固件检查、离线测试、前端构建和 Go 构建，不连接硬件。Pages 工作流在 `main` 推送或手动触发时运行同样的源码检查、测试和前端构建，并在 `--include-dist` 检查通过后仅部署 `dist/` 静态资源。

| 入口 | 用途 |
| --- | --- |
| [src/main.tsx](src/main.tsx) | 页面与使用指南 |
| [src/backend.ts](src/backend.ts) | 文件处理、操作状态与备份保存门槛 |
| [src/webhid-protocol.ts](src/webhid-protocol.ts) | 接口探测、Flash 读写与验证 |
| [src/storage.ts](src/storage.ts) | 本机浏览器备份和恢复记录 |
| [launcher.go](launcher.go) | 仅监听回环地址的静态服务 |

固件、ROM、设备备份和恢复包不进入 Git；[.gitignore](.gitignore) 已忽略常见设备镜像与备份目录，提交前运行 `npm run check:source`。生成仅含源码的压缩包：

```sh
npm run package:source
```

## 许可

本项目代码采用 [MIT License](LICENSE)。协议来源与依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。许可不覆盖使用者自行导入的固件或备份。
