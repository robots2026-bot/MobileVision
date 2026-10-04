# 2026-10-02 Electron GPU 启动诊断

## 结论与边界

同一 Electron 44.3.0 / Chromium 152.0.7977.78，在 Codex 受限任务执行环境中默认启动时 GPU 子进程以 -1073741515（0xC0000135）退出，渲染进程 launch-failed。任务沙箱外使用相同文件和默认参数，独立页面与完整项目隔离冒烟均通过。未修改应用 webPreferences.sandbox、驱动、运行库、全局权限或 Windows 策略。

这证明当前失败受执行环境影响，不能据此认定电脑缺 DLL 或驱动损坏。尚未捕获具体失败的 DLL 加载名称，权限/令牌原因属于推断。独立探针报告 disabled_software / inProcessGpu，故页面加载和功能冒烟通过不等于 GPU 硬件加速验收。

## 实验

证据目录：windows/test-results/gpu-diagnosis/（本地忽略，不提交用户环境输出）。

- probe.cjs：sandbox:true、contextIsolation:true、nodeIntegration:false；隐藏窗口加载独立 data 页面，读取 GPU 信息与页面文字，15 秒超时。各次使用 PID 独立 userData。
- restricted-clean.out.log / restricted-clean.err.log：默认 Electron、受限任务环境，退出 1，GPU crash 0xC0000135，页面 ERR_FAILED。
- unrestricted-clean.out.log / unrestricted-clean.err.log：相同文件和参数、任务沙箱外，退出 0，PAGE_LOADED 与 RENDERER_TEXT 正常。硬件加速未确认。
- no-gpu-sandbox.*：仅 --disable-gpu-sandbox 不足以解除渲染进程启动失败，退出 1。
- 首次探针共用缓存出现 cache access denied / decrypt 失败，改为 PID 独立目录后排除混用缓存影响；不用于最终对比结论。
- project-default.out.log / project-default.err.log：任务沙箱外 Electron . --smoke-test，无 --no-sandbox/--disable-gpu-sandbox，退出 0。smoke.json passed=true。stderr 的“剪贴板里是文字”来自预期负向测试。
- 受限环境读取 Win32_VideoController 被拒绝；外部探针枚举 NVIDIA GeForce RTX 5060 Ti 32.0.15.9579 与 AMD Radeon(TM) Graphics 32.0.21043.5001，不等于性能验收。

## 后续运行

诊断/界面测试如遇同类限制，在获准的任务沙箱外运行默认参数，保留应用自身的 Electron 沙箱。不要把 --no-sandbox 作为产品修复，也不要仅凭此错误安装运行库或改 ACL。

参考：
- Chromium sandbox：https://chromium.googlesource.com/chromium/src/+/HEAD/docs/design/sandbox.md
- Microsoft DLL 访问令牌相关错误：https://learn.microsoft.com/en-us/troubleshoot/windows-client/setup-upgrade-and-drivers/loadlibrary-function-returns-status-dll-not-found-error-impersonate-thread
