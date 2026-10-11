# github-accel-loon · GitHub 下载加速（akams 自动择优）

Loon 插件：**定时从 [github.akams.cn](https://github.akams.cn/) 的加速节点列表测速，自动挑出最快的节点，并把 GitHub 的下载链接改写到该节点。**

不用手动挑镜像、不用记 URL 格式 —— 装完就一直是当下最快的那个。

---

## 特性

- **自动择优**：从 akams 的 80+ 个加速节点里，先并发测延迟，再对最快的几个做真实文件下载测速，按 Mbps 排名
- **自动更新**：每 6 小时重测一次；akams 站点新增/删除节点也会自动同步（解析站点前端 chunk 里的节点列表）
- **只碰下载**：白名单只命中「纯下载」路径，GitHub 登录、网页、`api.github.com` 一律放行，不会把正常访问搞坏
- **防抖**：新节点提升不到 30% 就不切换，避免每次测速都换节点
- **可兜底**：站点同步失败时回落脚本内置的 81 个节点快照；最优节点信息过期/为空时改写直接放行，绝不阻断下载

## 安装

### 1. 导入插件

Loon → 配置 → 插件 → 右上角 `+` → 添加：

```
https://fastly.jsdelivr.net/gh/aoconch/github-accel-loon@main/github-accel.plugin
```

或直接点这里安装：<https://fastly.jsdelivr.net/gh/aoconch/github-accel-loon@main/github-accel.plugin>

> **为什么用 jsDelivr 而不是 raw.githubusercontent.com？**
> 如果你的 Loon 配置里 raw.githubusercontent.com 走了某个代理策略，而该节点拉 raw 失败，Loon 会连**脚本本体**都下载不到——表现为插件/脚本页打开一片空白。jsDelivr 国内可直连，作为脚本分发源稳定得多（脚本本体仍固定在不可变 commit SHA 上）。

### 2. 开启 MITM 并信任证书

本插件需要 MITM（原因见下文「必须知道的代价」）。确认：

- Loon 的 MITM 开关已打开
- Loon 的 CA 证书已安装，且**在 iOS 设置 → 通用 → 关于本机 → 证书信任设置中已信任**

### 3. 首次务必先自检、再跑测速

刚装好时本地没有测速结果，改写脚本会直接放行（不会报错，只是不加速）——**这是「装了却没效果」最常见的原因**。

去 Loon 的**「脚本」页**：

1. 先点运行 `GitHub加速自检`：它会直接告诉你卡在哪一环（没测速 / 节点失效 / 链路正常但 MITM 没生效）
2. 再点运行 `GitHub加速节点测速`，成功会收到通知：

```
GitHub 下载加速
gh.dpik.top 最优
延迟 118ms · 速度 9.8Mbps
可用 74/80 个节点，耗时 21.3s
备选：ghproxy.net ghfast.top ghproxy.icu
```

之后每 6 小时自动刷新；**只有选中的节点变了才会再通知你**。

### 4. 验证生效

随便下个 release 文件，在 Loon 的「请求记录 / 日志」里能看到目标域名变成了加速节点：

```
https://github.com/pypa/pip/archive/refs/tags/24.3.1.zip
        ↓
https://gh.dpik.top/https://github.com/pypa/pip/archive/refs/tags/24.3.1.zip
```

## 配置项

在插件配置界面填（对应 `#!input`），或直接在插件里那两条 script 行末尾加 `argument="k=v&k2=v2"`（`argument` 优先级更高）。

| 参数 | 默认 | 说明 |
|---|---|---|
| `remoteList` | true | 实时从 akams 同步节点列表；失败自动回落内置快照 |
| `listTtlHours` | 12 | 节点列表缓存时长，避免每次 cron 都去爬站点 |
| `includeSearch` | true | 是否把「测绘」类节点也纳入测速（false 则只测「贡献」节点） |
| `latencyTimeout` | 3000 | 单节点延迟测试超时(ms) |
| `latencyPassMax` | 2500 | 延迟高于此值不进入速度测试 |
| `speedCount` | 4 | 进入真实下载测速的节点数 |
| `speedTimeout` | 15000 | 速度测试超时(ms) |
| `keepRatio` | 0.3 | **防抖**：新最优比旧最优提升不到该比例就不切换 |
| `notify` | true | 是否发 iOS 通知 |
| `nodePolicy` | DIRECT | 改写后的请求走哪个策略/节点（加速节点多为国内/近岸 CDN，建议 DIRECT） |
| `enable` | true | 改写总开关。设 `false` = 只测速不改写，纯当「哪条线路快」的参考工具 |
| `maxAgeDays` | 30 | 最优节点信息超过该天数没更新就不再改写 |
| `debug` | false | 输出详细日志到 Loon 日志 |

## 工作原理

### 数据来源（akams 逆向结论）

`github.akams.cn` 是 Next.js 静态站，**没有开放 API**。节点列表硬编码在 `/_next/static/chunks/*.js` 里，脚本用两级正则拿：

```
1) 首页 HTML  →  /_next/static/chunks/([A-Za-z0-9_\-]+)\.js/g   取出 chunk 列表
2) 各 chunk   →  /label:"(contribute|search)",value:"([^"]+)"/g  取出节点
```

站点规则：`contribute` = 网友贡献节点，`search` = 测绘节点。**实测 81 个（contribute 50 + search 31），其中 1 个 IDN 域名需要过滤。**

加速格式是**路径前缀式**：

```
https://<节点域名>/https://github.com/pypa/pip/archive/refs/tags/24.3.1.zip
```

> 站点自身也是这么测的：用 `<img>` 加载 `https://<节点>/https://raw.githubusercontent.com/…/code.png` 量延迟，用 fetch 拉 release 文件算 Mbps。本插件沿用同一套方法。

### 流程

```
① cron（每 6h）
   akams 首页 → 抓 _next chunk → 正则提节点列表
        ↓
   并发 8 测延迟（超时 3s，用 raw 小图）
        ↓
   延迟合格 Top4 → 真实文件下载测速（≈1.7MB）
        ↓
   最优节点 → Loon 本地存储 gh_accel_best

② 请求时（http-request）
   命中下载类 URL → 读 gh_accel_best → 改写 URL → 强制走 DIRECT
```

两个脚本只通过 Loon 本地存储通信，**没有任何服务端依赖**，也不收集任何数据。

改写的 URL 白名单：

| 命中 | 示例 |
|---|---|
| ✅ | `github.com/*/*/releases/download/…`、`releases/latest/download/…` |
| ✅ | `github.com/*/*/archive/…` |
| ✅ | `github.com/*/*/raw/…` |
| ✅ | `raw.githubusercontent.com/…` |
| ✅ | `codeload.github.com/…`、`gist.githubusercontent.com/…` |
| ❌ 放行 | `github.com` 网页、登录、`api.github.com`、git 协议（`/info/refs`） |

## 必须知道的代价

**MITM 是硬性前提，绕不过去。** Loon 官方说明「复写仅针对 http 请求或经过解密后的 https 请求有效」，而加速格式是**路径前缀式**（`https://节点/https://github.com/…`，不是子域式），所以在 DNS / 分流层面根本没法做这件事。代价是：

- 所有 `github.com` 流量会在本机被 Loon 解密再加密。数据不出设备，但证书必须信任，且大文件下载会多一层加解密开销
- 极端情况下如果出现下载卡住/中断，把 `enable` 设为 `false` 对比一次就能定位

## 已知限制

1. **不加速 `git clone`**：`/info/refs` 走 git 智能协议，公共镜像基本不支持，硬改必失败。建议单独配：
   ```bash
   git config --global url."https://gh-proxy.com/https://github.com/".insteadOf "https://github.com/"
   ```
2. **公共镜像存活率约一半**：81 个节点里长期可用的通常不到一半，个别会临时挂掉或限速。缓解靠定时重测 + 防抖 + 过期放行；最坏情况下会有短暂失败窗口。**如果你本来就有稳定大带宽节点，让 `github.com` 走自己的节点通常更快更稳** —— 本插件的价值主要在「没有好节点」或「节点本身也慢」的场景，因为加速节点多在近岸/国内。
3. **IDN 域名会被跳过**：如 `ghf.无名氏.top` 无法安全拼进改写 URL，脚本自动过滤（少 1 个候选，无影响）。
4. **iOS 后台 cron 会延迟**：Loon 的定时任务依赖 App 存活 + VPN 连接，息屏久置时会延后触发。改写逻辑不依赖 cron 及时性（用的仍是上次结果）。
5. **`objects.githubusercontent.com` 不在名单**：release 资产的重定向由镜像在服务端完成，客户端不会再请求它。

## 排查

| 现象 | 处理 |
|---|---|
| 从没收到测速通知 | cron 没触发。去「脚本」页手动运行一次，看 Loon 日志 |
| 手动跑一直失败 | 设 `debug=true` 看日志卡在哪步；`remoteList=false` 可强制用内置列表 |
| 有通知但下载没加速 | ① 没手动跑过测速 ② URL 不在白名单 ③ MITM 没开或证书没信任 |
| 下载报 SSL/TLS 错误 | 加速域名被你的规则走了代理节点，把 `nodePolicy` 显式设为 `DIRECT` |
| 节点突然全部变慢 | 手动跑一次测速重选；也可调低 `latencyPassMax` 提高门槛 |
| 改了 JS 但 Loon 还在跑旧版 | `script-path` 必须用 commit SHA，不能用 `main`（CDN 有缓存）。重跑 `deploy.sh` 会自动重新固定 |

## 发布（维护者用）

```bash
bash deploy.sh
```

脚本会：先把脚本本体提交、取到不可变 commit SHA → 用该 SHA 渲染 `github-accel.plugin` 的 `script-path` → 再次提交 → 建仓/推送 → 打印 Loon 导入地址。改完 JS 直接重跑即可（脚本会自动把旧 SHA 还原成占位符）。

## 致谢与免责

- 节点列表来自 [github.akams.cn](https://github.akams.cn/)（公益服务，加速源由热心网友贡献），请勿滥用
- 本插件只做「测速 + 改写」，不代理、不缓存、不收集任何数据；加速节点的可用性、速度与安全性由各节点提供者负责
