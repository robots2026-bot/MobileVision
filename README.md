# MobileVision

用 Android 手机拍照、导入相册或直接手写，图片会通过局域网自动传到 Windows 电脑，并可一键粘贴到当前输入位置。

> 当前版本：`0.3.0`　支持 Windows 10/11 与 Android 10 及以上版本。

## 主要功能

### Android

- CameraX 拍照并自动上传原图。
- 从系统相册导入图片并自动上传。
- 电容笔书写模式：画笔、橡皮、撤销、重做、清屏、七种颜色和 32 级粗细。
- 独立横屏书写界面，工具浮在画布上，旋转后保持笔画实际粗细。
- 一键“同步并贴图”，上传后直接插入 Windows 当前焦点输入框。
- 上传失败自动进入本地队列，恢复连接后重试。

### Windows

- 显示配对二维码，在可信局域网内接收 Android 图片。
- 自动保存原图、生成缩略图，并在主预览区浏览历史图片。
- 多选删除、鼠标滚轮缩放和拖动查看。
- 右键进入截图模式，移动或调整截图框，双击复制选区到剪贴板。
- 新图片到达时自动切换到最新图片。

## 开发中的文件传输

最新源码新增 Android ↔ Windows 文件互传：两端“文件”页都支持多选发送，电脑还支持拖入文件和粘贴资源管理器复制的文件。手机收到文件后保存在系统“下载/MobileVision”，可点击打开；电脑可打开、定位接收文件或更改保存目录。支持 2 GB 单文件、进度、取消、重试与断点续传，默认保存在 `下载\MobileVision\年-月-日`。此功能包含在 0.3.0 构建中，GitHub 发布待完成。详见 [文件传输说明](docs/FILE_TRANSFER.md)。

## 开发中的文本消息

最新源码支持手机与电脑双向文本消息、多行输入、离线队列、消息复制与本地草稿。手机可以“发送并复制到电脑”，电脑 Ctrl+Enter 发送。每条最多 64 KB，两端需要 0.3.0 构建，GitHub 发布待完成。见 [文本消息说明](docs/TEXT_MESSAGES.md)。

## 快速开始

1. 从 GitHub Releases 下载 `MobileVision-Windows-v0.3.0-x64.exe` 和 `MobileVision-Android-0.3.0-debug.apk`。
2. 在 Windows 上安装并启动 MobileVision。如 SmartScreen 提示未知发布者，请核对 Release 页面提供的 SHA-256 后再决定是否运行。
3. 在 Android 上安装 APK，并允许相机、照片访问等必要权限。
4. 确保手机和电脑连接到同一个局域网。
5. 用手机扫描电脑端显示的配对二维码。
6. 拍照、导入相册或书写后同步，电脑端会自动显示并保存原图。

## 数据与安全

- 图片只在已配对设备之间通过局域网传输，不经过云端。
- 传输使用 HTTPS，并校验接收端证书指纹。
- 配对凭据由 Android Keystore 保护。
- Windows 默认将原图保存到 `图片\MobileVision\年-月-日`；保存目录可在软件中修改。
- Windows 应用数据和缩略图位于 `%APPDATA%\mobilevision-desktop`。

## 项目结构

```text
MobileVision/
├─ android/                 Android Kotlin + Jetpack Compose 客户端
├─ windows/                 Windows Electron + React 接收端
├─ docs/RELEASING.md        正式发布流程
├─ PROJECT_PLAN.md          产品范围和协议设计
├─ PROJECT_STATUS.md        验证记录和已知边界
└─ CHANGELOG.md             版本更新记录
```

## 本地开发

Windows 端需要 Node.js 和 npm：

```powershell
cd windows
npm.cmd ci
npm.cmd start
```

Android 端需要 JDK 17 和 Android SDK，也可以直接使用 Android Studio 打开 `android` 文件夹：

```powershell
cd android
.\gradlew.bat assembleDebug
```

完整测试、签名和自动发布步骤见 [发布流程](docs/RELEASING.md)。详细说明见 [Android 文档](android/README.md)、[Windows 文档](windows/README.md) 和 [接口协议](windows/docs/WINDOWS_API.md)。

## 当前限制

- 一台 Android 手机配对一台 Windows 电脑。
- 仅支持局域网，不提供公网连接、云账号或云同步。
- 不支持视频流和虚拟摄像头。
- Windows 安装包目前没有商业代码签名证书，首次运行可能触发 SmartScreen。

## 许可证

当前代码保留全部权利，仅允许查看和个人开发评估。未经许可不得复制、修改、分发或商用，详见 [LICENSE](LICENSE)。第三方依赖遵循各自许可证。
