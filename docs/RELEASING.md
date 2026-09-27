# MobileVision 发布流程

## 版本规则

Windows `package.json` 与 Android `versionName` 使用相同版本号。Android 每次发布还必须递增 `versionCode`。Git 标签使用 `v<版本号>`，例如 `v0.2.0`。

## GitHub Actions Secrets

Android 正式安装包必须签名。先在安全位置创建并备份 keystore，然后在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中配置：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 Base64 内容 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

本机已有 `.signing` 目录时，安装并登录 GitHub CLI 后可以从仓库根目录运行 `./scripts/configure-github-secrets.ps1`，一次写入上述四项 Secret。脚本不会输出密码，也不会把签名文件加入 Git。

Windows 代码签名是可选项。购买代码签名证书后可增加 `CSC_LINK` 和 `CSC_KEY_PASSWORD` Secrets，`electron-builder` 会自动使用它们。没有证书时仍能生成安装包，但 Windows 可能显示 SmartScreen 提示。

## 自动发布

1. 确认 `main` 分支 CI 全部通过。
2. 检查 `CHANGELOG.md`、两端版本号和 Android `versionCode`。
3. 创建并推送标签：

   ```powershell
   git tag -a v0.2.0 -m "MobileVision v0.2.0"
   git push origin v0.2.0
   ```

4. `Release` 工作流会构建 Windows 安装程序和已签名 Android APK，生成 SHA-256 校验文件，并创建 GitHub Release。
5. 在一台未安装开发工具的 Windows 电脑和一台真实 Android 手机上完成安装、配对、拍照、相册导入、书写同步和贴图验收。

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

本地没有发布签名环境变量时，Android `assembleRelease` 会生成未签名包，该文件不能作为正式安装包发布。
