# MobileVision Android

Android 手机拍照，自动把原始 JPEG 传到 Windows，并等待电脑保存成功确认。

## 已实现

- CameraX 相机预览、前后镜头切换、拍照、本地照片查看；也可通过系统图片选择器从相册导入并自动上传。
- 独立书写模式使用单行图标工具栏，支持画笔、带单层半透明触点圆面的橡皮擦、8 种颜色、1–32 级自由粗细（最粗约 1 cm）、撤销、重做、立即清屏和同步；清屏不再弹出确认框。旋屏会保留画笔颜色、粗细级别和画笔/橡皮状态，物理笔宽使用横纵 DPI 的平均值计算，横竖屏保持一致。颜色和粗细使用可点外部关闭的紧凑弹窗，草稿自动保存在手机，点击同步生成 PNG 并进入同一上传队列。
- “同步并插入”会生成同一张无损 PNG，通过持久上传队列传给电脑，并要求 Windows 在首次接收成功后将图片粘贴到当前焦点输入框；离线时该意图随任务保留，重复确认不会再次粘贴。
- 相机扫描二维码，或手动粘贴完整配对内容；显示电脑名称后由用户确认连接。
- HTTPS 严格验证二维码中的证书 SHA-256 指纹和有效期，不接受任意证书，不跟随重定向。
- 配对凭据使用 Android Keystore AES-GCM 加密保存在本地；设备 UUID 持久化。
- 拍照先落地手机，再自动上传；SQLite 队列记录待传、上传中、已传和需处理状态。
- 网络故障自动退避重试（最长间隔 60 秒）、手动重试、进程重启后恢复待传任务。
- 更换电脑时，原电脑的待传照片继续保留，不会自动发送到新电脑。
- 用户确认后清理已传照片的手机副本，不删除待传照片或电脑文件。

首版仅在 App 前台自动发起传输。退出后照片和队列仍保留，下次打开会继续；不提供后台常驻服务。

## 使用

1. 打开 Windows 端，选择可被手机访问的局域网地址，显示二维码。
2. 在手机点击“扫描二维码”，授予相机权限，确认电脑名称并配对。
3. 点击“拍照”，或点击“导入相册”选择现有图片。即使电脑暂时离线，也会保存到 App 本地队列；连接恢复后自动上传。
4. 电脑显示照片，手机显示“已传到电脑”。

也可以切换到底部“书写”，用手指或电容笔书写。点击“同步”只发送当前画面的 PNG 快照，手机草稿仍可继续修改；再次同步会在电脑生成一个新版本。

重新配对时，请先在电脑解除原配对。手机断开只删除本机凭据，不会远程撤销电脑端的配对记录。

照片在 App 私有目录中，不自动写入系统相册；卸载 App 会删除手机副本。不要在待传照片未完成时卸载或清除数据。

相册导入使用 Android 系统图片选择器，不申请读取整个相册的权限。JPEG 会保留原文件；PNG、WebP、HEIF 等系统可解码图片会转换成高质量 JPEG 后上传。单张输入上限 50 MB、6000 万像素。

## 开发环境

- 工程目录：MobileVision/android，与 windows 平级。
- 包名：com.mobilevision.android；版本 0.2.0。
- Kotlin + Compose + Material 3，最低 Android 10（API 29），compileSdk / targetSdk 35。
- AGP 8.10.0、Gradle 8.11.1、Kotlin 2.0.21；兼容本机 Android Studio 2024.3.2。
- 本机 SDK：D:/Software/AndroidSDK；JDK：Android Studio 自带 jbr 21.0.6。
- 队列使用 Android SQLiteOpenHelper，避免当前小型工程额外引入 Room/KSP 代码生成；表结构和版本管理集中在 PhotoStore。

Android Studio 的 Open 选择 android 文件夹，等待 Gradle Sync。

## 构建与测试

在 android 文件夹执行：

```powershell
$env:JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr'
./gradlew.bat assembleDebug assembleDebugAndroidTest testDebugUnitTest
```

若当前桌面代理环境出现 Java 的 Unable to establish loopback connection，仅在当前终端设置后重试：

```powershell
New-Item -ItemType Directory -Path '.gradle/sockets' -Force | Out-Null
$env:JAVA_TOOL_OPTIONS = '-Djdk.net.unixdomain.tmpdir=C:/Users/FamilyWang/code/MobileVision/android/.gradle/sockets'
```

APK：app/build/outputs/apk/debug/MobileVision-Android-0.2.0-debug.apk。测试 APK：app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk。

完整跨端测试：启动 emulator-5554，安装两个 APK，然后在 windows 文件夹执行 npm.cmd run test:android。此命令会重置指定模拟器内 MobileVision 的测试数据，不应用于存有需要保留照片的模拟器。测试不会操作真实手机。

测试用独立 Windows 用户数据目录和本地 HTTPS 代理来模拟掉线，不修改正常接收服务的认证逻辑。Android 10.0.2.2 访问宿主机，不能据此证明真实 Wi-Fi 和防火墙已通过验证。

仪器测试覆盖二维码解码（正常与旋转）、错误证书拒绝、界面配对、模拟器 CameraX 拍照、离线保留、进程重启续传、重复上传。最终校验两端文件 SHA-256 与 Windows 实际预览。

二维码图像解码测试不能替代真实手机对电脑屏幕的光学扫码测试。真实设备权限拒绝/重新授权、后台行为、镜头兼容性和局域网连接仍需真机验收。

## 相关文档

- [总体方案](../PROJECT_PLAN.md)
- [Windows 接口](../windows/docs/WINDOWS_API.md)

## 最新验证结果

2026-09-13：应用/测试 APK 构建成功，1 项单元测试、2 项跨端仪器测试通过。最终测试使用真实 CameraX 模拟器相机和打包后的 Windows 程序，验证断线、进程重启续传、两张原图 SHA-256 和桌面预览。详见 [项目状态](../PROJECT_STATUS.md)。真机验收未完成。

## 本次修复验证

新增本地时区时间、固定底部快门、照片记录分页、安全更新电脑地址、丢失配对响应恢复和连接提示刷新。4 项单元测试与 2 项跨端仪器测试通过；真实手机保留数据更新安装并通过 Wi-Fi 恢复连接。光学扫码和完整镜头验收尚未完成。当前状态以 [项目状态](../PROJECT_STATUS.md) 为准。

## 拍摄界面调整

拍摄页顶部仅保留电脑名称、连接状态和设置入口；扫码、粘贴配对信息、重试、断开移入连接设置弹窗。取景区随剩余屏幕高度伸展，快门固定在底部。拍摄/照片记录改为带图标和选中高亮的 Material 导航栏，待传数量保留为一行提示。

取景框进一步改为按 CameraX 实际裁剪区域和旋转信息计算宽高比，保持完整预览，不拉伸画面；窗口下紧接传输状态与快门，页面导航仍在底部。
