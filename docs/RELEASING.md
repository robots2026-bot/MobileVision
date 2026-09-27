# MobileVision 发布流程

## 版本规则

Windows `package.json` 与 Android `versionName` 使用相同版本号。Android 每次发布还必须递增 `versionCode`。Git 标签使用 `v<版本号>`，例如 `v0.2.0`。

## Android 本地签名

Android 发布密钥只保存在发布电脑的 `android/.signing` 目录，不上传 GitHub，也不会加入 Git。必须离线备份整个目录；后续版本需要使用同一密钥，手机才能覆盖升级现有应用。

发布前在本机配置 `MOBILEVISION_KEYSTORE_PATH`、`MOBILEVISION_KEYSTORE_PASSWORD`、`MOBILEVISION_KEY_ALIAS` 和 `MOBILEVISION_KEY_PASSWORD` 环境变量，再运行 `assembleRelease`。将生成的已签名 APK手动上传到对应 GitHub Release。

Windows 代码签名是可选项。购买代码签名证书后可增加 `CSC_LINK` 和 `CSC_KEY_PASSWORD` Secrets，`electron-builder` 会自动使用它们。没有证书时仍能生成安装包，但 Windows 可能显示 SmartScreen 提示。

## 自动发布

1. 确认 `main` 分支 CI 全部通过。
2. 检查 `CHANGELOG.md`、两端版本号和 Android `versionCode`。
3. 创建并推送标签：

   ```powershell
   git tag -a v0.2.0 -m "MobileVision v0.2.0"
   git push origin v0.2.0
   ```

4. `Release` 工作流构建 Windows 安装程序并创建 GitHub Release。
5. 在本机使用保留的 Android 发布密钥构建 APK，将 APK与包含两端安装包校验值的 `SHA256SUMS.txt` 上传到 Release。
6. 在一台未安装开发工具的 Windows 电脑和一台真实 Android 手机上完成安装、配对、拍照、相册导入、书写同步和贴图验收。

## 本地预发布检查

```powershell
cd windows
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run installer

cd ..\android
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug
```

本地没有发布签名环境变量时，Android `assembleRelease` 会生成未签名包，该文件不能作为正式安装包发布。发布前必须使用 `apksigner verify --verbose --print-certs` 验证 APK。
