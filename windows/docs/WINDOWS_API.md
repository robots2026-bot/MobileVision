# Windows 接收端协议 v1

适用于当前 Windows 预览版。Android 已按本文协议实现配对和上传。

## 配对二维码

二维码为 UTF-8 JSON，包含 version（1）、address（https://IP:port）、computerId、computerName、token、expiresAt（Unix 毫秒）和 certificateSha256（DER 证书 SHA-256，小写十六进制，无冒号）。

手机必须依据二维码指纹验证服务端证书；不允许接受所有证书。证书为自签名，不依赖系统公共 CA。需要同时检查有效期，并只信任扫码确认的电脑身份。新地址不能自动继承其他电脑的信任。

## POST /api/v1/pair

请求 JSON：

```json
{"token":"二维码中的一次性令牌","deviceId":"持久化的设备 UUID","deviceName":"手机名称"}
```

201 响应包含 credential、computerId、version。手机安全存储 credential，后续请求带 Authorization: Bearer <credential>。

令牌有效 5 分钟，成功配对后失效。已存在配对时返回 ALREADY_PAIRED，需要在电脑解除配对后重新扫码。连续 20 次认证失败后暂时限流，窗口为 60 秒。

## GET /api/v1/status

需认证。200 返回 version、accepting、computerId。accepting=false 表示当前正在接收其他上传。手机前台建议每 10 秒请求一次，用于在线状态和连接检测。

## PUT /api/v1/photos/{photoId}

photoId 必须为 UUID，每张图片生成一次，重试保持不变。JPEG 或 PNG 字节作为请求体，携带：

| 请求头 | 内容 |
| --- | --- |
| Authorization | Bearer <credential> |
| Content-Type | image/jpeg |
| Content-Length | 原始文件精确字节数，必须提供 |
| X-Content-Sha256 | 原文件 SHA-256，小写 64 位十六进制 |
| X-Captured-At | ISO 8601 拍摄时间，建议带时区，例如 2026-09-13T14:00:00+08:00 |

上限 50 MiB，图片最多 6000 万像素。首版不支持分片和断点续传；失败后整张重试。

首次成功返回 201：

```json
{"id":"电脑端记录 UUID","receivedAt":"2026-09-13T06:00:00.000Z","duplicate":false}
```

相同设备、相同 photoId 和相同大小及哈希返回 200，duplicate=true。响应不包含电脑文件路径。只有收到成功响应或成功查询到记录后，手机才能标记已传。

## GET /api/v1/photos/{photoId}/status

需认证，只查询当前设备的记录。已保存返回 200，包含 id 和 receivedAt；不存在返回 404。适用于成功确认丢失后的查询。

## 错误与重试

错误结构为 {"error":{"code":"错误码"}}。

| 状态 | 错误码示例 | 手机处理 |
| --- | --- | --- |
| 400 | INVALID_JSON / INVALID_DEVICE / CONTENT_LENGTH_REQUIRED / INVALID_HASH / INVALID_CAPTURE_TIME | 修正请求，停止无限重试 |
| 401 | UNAUTHORIZED | 保留照片，重新配对 |
| 404 | NOT_FOUND | 查询时表示没有已确认记录，可重试上传 |
| 409 | ALREADY_PAIRED | 在电脑解除原配对 |
| 409 | RECEIVER_BUSY | 短暂退避后重试 |
| 409 | PHOTO_ID_CONFLICT / SAVED_FILE_CHANGED | 提示用户，不覆盖已有文件 |
| 410 | PAIRING_EXPIRED | 刷新二维码 |
| 413 | FILE_TOO_LARGE | 超出限制，保留本地原图并提示 |
| 415 | IMAGE_TYPE_REQUIRED | 发送 JPEG 或 PNG 原文件 |
| 422 | CHECKSUM_MISMATCH / INVALID_IMAGE | 检查本地文件，停止无效重试 |
| 429 | TOO_MANY_ATTEMPTS | 等待后重新连接 |
| 500 | DISK_FULL / DIRECTORY_UNAVAILABLE / INTERNAL_ERROR | 保留照片，电脑端处理后再试 |
| 503 | STOPPING | 电脑正在退出，稍后重连 |

连接中断可能没有 JSON 响应；同样保留照片并以原 photoId 重试。不要因为一次网络超时创建新的 photoId。

## 存储一致性

上传开始前建立 pending 记录，写入目标目录内的 .part 文件；校验哈希和 JPEG/PNG 解码后重命名，再提交 ready 状态并确认。启动时验证未完成记录，恢复完整文件、清理未完成临时文件。完整原图与 UI 缩略图分开存储。

电脑端原文件如果被外部移动或修改，历史记录可能仍显示；重传相同 ID 不会静默覆盖。首版没有自动扫描外部文件变更或修复历史记录功能。

## 配对确认恢复与地址更新（2026-09-13）

POST /pair 可选 `credential`：客户端用安全随机源生成的 32 字节小写十六进制凭据（64 字符）。客户端发送前须加密持久化候选 Session；服务端仍校验一次性配对 token，仅存凭据哈希。成功响应丢失后，客户端使用候选凭据 GET /status，验证电脑 ID 后转为正式 Session。未提供该字段的旧客户端仍由服务端生成凭据。已配对时不会允许第二次 POST /pair。

已配对电脑可以展示不含 token 的地址二维码。手机只有在 computerId 和 certificateSha256 都与原 Session 一致，且新地址 GET /status 认证通过后才保存新地址。电脑证书变更须另行重新配对，不能自动信任。
