# Android 调试部署记录（2026-10-10）

目标：编译绘图工具栏修复并覆盖安装，保留手机应用数据。执行位置：Windows 主机。

环境：Android Studio JBR OpenJDK 21.0.6，Gradle 8.11.1，SDK D:/Software/AndroidSDK。

初次构建因 JAVA_HOME 未设置失败；指定 JBR 后出现 `Unable to establish loopback connection`，堆栈指向 UnixDomainSockets.connect。IPv4、WindowsSelectorProvider 与 java.io.tmpdir 未解决。指定 jdk.net.unixdomain.tmpdir 后客户端恢复，但守护进程未继承参数。最终通过 JAVA_TOOL_OPTIONS 将该参数传递给所有 Java 子进程，构建成功。此结果支持临时 socket 路径有关的判断，未进一步确认系统根因。

可复用命令：test-results/deploy-build.cmd（JAVA_HOME 指向 Android Studio jbr，JAVA_TOOL_OPTIONS 指向项目内 test-results/java-tmp），调用 assembleDebug --console=plain --no-daemon。不修改系统级 Java 设置。

验证：assembleDebug 退出码 0，BUILD SUCCESSFUL，35 tasks；生成 android/app/build/outputs/apk/debug/MobileVision-Android-0.3.0-debug.apk。用户提供无线调试地址后 adb connect 成功，adb install -r 返回 Success、退出码 0。实际工具栏视觉效果由用户在手机确认。

记录依据：本次工具输出摘要，未保存完整原始构建日志。
