# 用 Surge Mac 给手机抓包

在 Mac 上运行 Surge，接管 iPhone 或 Android 手机的流量，在 Mac 的 Dashboard 里查看请求。下面以 HTTPS 接口 `https://api.example.com/v1/profile` 为例，请换成自己的测试接口。

## 1. 准备环境

- 一台正在运行 Surge Mac 的 Mac，以及一台 iPhone 或 Android 手机。手机通过 Wi‑Fi 与 Mac 处于能互相访问的局域网，Mac 可以用网线接入。
- 在 Mac 上打开 Surge Dashboard。下面的请求记录都在这里查看，手机只负责发起请求。
- 如果只抓明文 HTTP，可跳过证书和 MITM 设置，直接配置手机流量如何经过 Mac。[Surge HTTP 处理文档](https://manual.nssurge.com/http/overview.html)

## 2. 在 Mac 导出证书，在手机安装并信任

1. 在 Surge Mac 的「HTTPS 解密」里检查当前配置使用的 CA 证书。如果已有证书，直接沿用。首次配置时，按界面提示生成 CA，并完成 Mac 上的安装和信任。[Surge MITM 文档](https://manual.nssurge.com/http/mitm.html)
2. 可从同一界面选择「为 iOS 模拟器导出证书」，把导出的 CA 公共证书传到测试手机。手机需要安装的是同一个 CA 的公共证书。PKCS#12（`.p12`）导出包含私钥，应留在 Mac 上。
3. 在手机上安装和信任这份证书。

   - **iPhone**：打开证书文件，按系统提示安装描述文件。然后到「设置 → 通用 → 关于本机 → 证书信任设置」，为该 Surge CA 开启完全信任。[Apple 证书信任说明](https://support.apple.com/en-gb/102390)
   - **Android**：在系统设置搜索「安装证书」，选择「CA 证书」，导入文件到用户证书存储。不同机型的菜单名称可能不同。面向 Android 7.0 或更高版本的 App 默认通常只信任系统 CA。调试自己的 App 时，可以让调试构建通过 Network Security Config 信任用户 CA。[Android 网络安全配置](https://developer.android.com/privacy-and-security/security-config)

如果以后在 Mac 上更换了 Surge CA，手机也要安装并信任新的证书。

## 3. 选择一种方式让手机流量经过 Mac

### 方式 A：局域网设备接管和手动 Wi‑Fi 代理

先用这条路线验证浏览器和遵循系统代理设置的 App。

1. 在 Surge Mac 的「局域网设备接管」中允许局域网设备访问 HTTP 代理，记下 Mac 的局域网 IP 和 **HTTP 代理端口**。端口通常是 `6152`，以 Surge 显示的为准。[Surge 局域网代理参数](https://manual.nssurge.com/profile/general.html#sharing-proxy-services-over-lan)
2. 在手机**当前连接的 Wi‑Fi** 里把代理改为「手动」。iPhone 在「设置 → 无线局域网 → 当前网络旁的 ⓘ → 配置代理」。Android 通常在当前 Wi‑Fi 的编辑页或高级选项里。服务器填 Mac 的局域网 IP，端口填上一步记下的 HTTP 代理端口。[Apple Wi‑Fi 网络设置](https://support.apple.com/zh-cn/102108) · [Android 网络设置](https://support.google.com/android/answer/9654714)
3. 在手机浏览器打开测试站点，在 Mac 的 Surge Dashboard 确认出现来自手机的连接。若浏览器有记录但目标 App 没有，App 可能绕过系统代理，可以试方式 B。

### 方式 B：网关模式

适合目标 App 不走手机的 Wi‑Fi HTTP 代理时使用。这条路线由 Surge 接管手机的路由，手机 Wi‑Fi 代理保持关闭。

1. 在 Surge Mac 中启用网关模式，并让测试手机通过 Surge 上网。已配置 Surge DHCP 时，可按设备接管设置自动下发网关和 DNS。
2. 手动配置时，按官方指南把手机的默认网关和 DNS 指向 Surge 提供的地址。使用 VM 网关时，网关填写 **Surge VM 网关 IP**。使用增强模式接管时，按指南填写 **Mac 的局域网 IP**。在 Dashboard 的设备列表确认手机已被接管。[Surge Mac 网关模式配置指南](https://kb.nssurge.com/surge-knowledge-base/zh/guidelines/gateway)

## 4. 配置 MITM 主机名并启动流量捕获

1. 抓 HTTPS 时，在 Mac 的「HTTPS 解密」里确认当前配置选中的 CA 与手机信任的是同一份。将 `api.example.com` 加入 **MITM 主机名**列表，然后启用 **MITM**。列表中填主机名，接口路径由 API Debug 的 `url` 参数匹配。[Surge MITM 文档](https://manual.nssurge.com/http/mitm.html)
2. 暂停会修改目标接口的规则，便于记录原始行为。在 Mac 上点「启动流量捕获」，按目标域名过滤。
3. 在手机上重做一次操作。回到 Mac 的 Dashboard，按设备、域名、时间和 HTTP 方法找到记录。打开详情查看完整 URL、请求和响应 Headers、Body 及响应状态码。能看到 `GET`、`POST` 等方法和完整 URL，说明请求已进入 Surge 的 HTTP 处理流程。[Surge HTTP 请求详情说明](https://manual.nssurge.com/http/overview.html#inspecting-the-results)

## 5. 从抓包结果填写 Module

假设这次捕获到的是 `GET https://api.example.com/v1/profile`，原始响应 Body 如下。

```json
{"data":{"name":"Alice","version":"1.0"}}
```

要将响应里的 `data.version` 改成 `debug`，在 API Debug 填写下面的参数。Module 的 `url` 是正则，示例用 `\.` 匹配域名里的点，用 `^` 和 `$` 限定整个地址。

```text
url=^https://api\.example\.com/v1/profile$
direction=response
target=body
action=set
path=data.version
value=debug
value_type=string
hit_limit=0
delay_ms=0
```

如果目标 URL 带查询参数，而同一路径上的参数值会变化，可把正则写成 `^https://api\.example\.com/v1/profile(?:\?|$)`。这个写法匹配精确路径以及该路径带查询参数的请求。

启用 Module 后再触发一次请求。在请求详情的 Notes 或事件记录里找 `[Surge API Debug]` 日志，确认脚本命中。再检查响应 Body 或 App 的实际表现。日志能帮助区分脚本没运行、路径没匹配和次数已经用完。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 手机请求没有出现在 Dashboard | 检查手机和 Mac 是否互通。使用手动代理时核对 IP 和 HTTP 端口，使用网关时确认手机已被接管。也检查流量捕获和域名过滤条件。 |
| 只看到主机和端口，没有完整 URL | 检查 Mac 的 MITM 开关和主机名列表，确认手机信任的是当前 Surge 配置使用的 CA。 |
| 开启 MITM 后目标 App 请求失败 | App 可能使用证书锁定。可换用允许调试的测试构建，或在浏览器验证同一接口。[Surge MITM 文档](https://manual.nssurge.com/http/mitm.html) |
| 能看到请求，但没有 API Debug 日志 | 核对 Module 是否启用、URL 正则和请求方向。检查是否有同方向的其他脚本优先匹配。 |
| 有日志，但改动没生效 | 检查 JSON 路径、值类型、`hit_limit` 和脚本版本。用一次新的请求确认结果。 |

抓包结束后关闭流量捕获，恢复手机原先的 Wi‑Fi 代理或网关设置。对外分享记录前，请去掉 `Authorization`、`Cookie`、`Set-Cookie` 以及 URL 或 Body 中的令牌和个人数据。

[返回 API Debug 使用说明](README.md)
