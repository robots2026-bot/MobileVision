# MobileVision

Android 手机拍照，Windows 自动接收、保存并展示原图。

## 项目结构

- `windows/`：Windows 客户端，包含源码、依赖、测试、构建配置和打包程序。
- `PROJECT_PLAN.md`：整体产品方案。
- `android/`：Android Kotlin + Jetpack Compose 工程。

## Windows 开发

```powershell
cd windows
npm.cmd start
```

已打包程序：`windows/release/win-unpacked/MobileVision.exe`，运行和分发时请保留整个程序文件夹。

- [Android 工程说明](android/README.md)
- [Windows 运行说明](windows/README.md)
- [Android 对接协议](windows/docs/WINDOWS_API.md)
- [整体方案](PROJECT_PLAN.md)

- [当前状态、验证证据与完善项](PROJECT_STATUS.md)
