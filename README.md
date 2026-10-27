# 网页阅读（dsh-web-read）

`网页阅读` 是 DeepSeek Harness 的一个工具插件。模型只看到 `web_read` 的 Tool Schema；
真正的网络访问、无头浏览器渲染、SSRF 校验和正文提取都在一个独立的 worker 进程中完成。

> **English:** a DeepSeek Harness plugin that reads public web pages inside an isolated worker
> with a headless browser, optional JavaScript rendering, readable text/HTML extraction and
> script inspection. Default-deny SSRF policy, structured JSON results, no Host credentials.
> See [SECURITY.md](SECURITY.md) for the security model.

- 工具名：`web_read`
- 包名：`dsh-web-read`
- 版本：`1.0.0`
- 入口：`lib/index.js`
- 目标：公开网页的可读正文（含 JavaScript 动态渲染）
- 许可：MIT
- 发布与安全：[PUBLISHING.md](PUBLISHING.md) · [SECURITY.md](SECURITY.md) · [CHANGELOG.md](CHANGELOG.md)

---

## 1. 它能做什么

| `mode` | 行为 | 是否执行页面 JS | 返回 |
|---|---|---|---|
| `text`（默认） | 读取 DOM，提取纯正文；去掉脚本、样式、导航、页脚和常见广告/弹层 | 否 | `content` 为纯文本 |
| `html` | 与 `text` 相同的正文定位，但输出精简 HTML 白名单 | 否 | `content` 为精简 HTML |
| `js` | 用无头浏览器执行页面 JS，等待 DOM 稳定后提取正文 | 是 | `content` 为渲染后的正文，并额外返回 `scripts` |

需求中的两个能力合并为 `mode=js`：

- `web_render`：执行页面 JS 后取正文；
- `js_inspect`：返回 `<script src>` 来源、内联脚本摘要、是否检测到动态加载。

不拆成两个布尔参数，避免出现 `mode=text` + `js_inspect=true` 这类互相矛盾的组合。
`wait_for` 可以继续等待异步组件出现，例如：

```json
{ "url": "https://quotes.toscrape.com/js/", "mode": "js", "wait_for": ".quote" }
```

---

## 2. 安装

本包是标准 DSH plugin bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，
patch 用 `insert` 挂载 Host 侧工具行 `tool-web-read`。无构建步骤、无运行时 npm 依赖。

### 从 GitHub / 本地目录安装

先把仓库克隆（或下载 Release 压缩包并解压）：

```bash
git clone <repo-url> dsh-web-read
cd dsh-web-read
```

然后在 Harness 的插件管理器里安装该目录的绝对路径。把下面的路径替换成你的 clone 目录：

```text
C:\path\to\dsh-web-read
```

对应 `plugin_manager` 调用：

```json
{
  "action": "install_bundle",
  "target": "C:\\path\\to\\dsh-web-read"
}
```

安装后，工具会在下一次模型请求的工具表中出现。若运行环境不允许自动重载，重启 Harness。
首次安装或替换包版本后必须重启，因为 Host 进程会缓存已加载的 ESM 模块。

> 发布到 GitHub 的完整步骤见 [PUBLISHING.md](PUBLISHING.md)。仓库里的
> `.github/workflows/ci.yml` 会在 Node 22/24 上运行离线单元测试。

### 运行前提

- Windows 上优先使用系统 Microsoft Edge，其次 Chrome；
- 需要允许 Host 进程启动浏览器子进程（Harness 自身不在文件沙箱内，工具调用在 Host 侧执行）；
- 需要能访问目标公网；插件不会代理或复用宿主机的 HTTP 代理设置。

> 当前 PowerShell/文件沙箱会以 `EPERM` 阻止 Chromium 的 Mojo 命名管道。验收真实网页时需要
> 使用非受限的 Host 进程（正常安装后的 Harness 工具调用即属于这种情况），而不是在受限
> PowerShell 里直接启动 worker。

---

## 3. Manifest

`package.json` 同时承担 npm 包清单和 DSH bundle manifest：

```json
{
  "name": "dsh-web-read",
  "version": "1.0.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "permissions": {
      "network": {
        "egress": "public-http-https-only",
        "ports": [80, 443],
        "sandboxedProxy": true,
        "credentials": "none"
      },
      "process": { "spawn": ["headless-browser", "isolated-worker"], "shell": false },
      "filesystem": { "scope": "ephemeral-temp-only", "workspace": "none" },
      "hostApis": [],
      "secrets": [],
      "codeExecution": false
    }
  }
}
```

`dsh.permissions` 是**可审计的声明**，不是 DSH Loader 自动执行的权限系统。真正的强制点
在 worker：即使有人改写声明，也不会放宽 `worker/policy.mjs` 和 `worker/proxy.mjs` 的检查。

补丁文件：`cordis.patch.yml`。

可配置项（只影响当前 profile，模型无法修改）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `allowedDomains` | `[]` | 空表示允许公网；非空时成为白名单，支持 `example.com`、`*.example.com` |
| `deniedDomains` | `[]` | 始终拒绝的域名，优先级高于白名单 |
| `allowedPorts` | `[80, 443]` | 允许的目标端口；建议保持默认 |
| `maxConcurrency` | `2` | 同时运行的浏览器 worker 数（1–4） |
| `browser` | `auto` | `auto` / `edge` / `chrome`；只在固定安装路径探测 |

---

## 4. Tool Schema

- 输入：`schema/web_read.input.json`
- 输出：`schema/web_read.output.json`

### 输入参数

| 参数 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `url` | string | 必填 | 仅 `http`/`https`，默认 80/443；不允许 URL 内嵌用户名/密码 |
| `mode` | enum | `text` | `text` / `html` / `js` |
| `wait_for` | string | — | CSS 选择器，最多 256 字符；等待元素出现后再提取 |
| `timeout_ms` | integer | `10000` | `1000`–`30000`；覆盖启动、导航、等待和清理 |
| `max_bytes` | integer | `200000` | `1000`–`1000000`；`content` 的 UTF-8 字节上限 |
| `include_links` | boolean | `false` | 是否返回页面内 http/https 链接（最多 100 条） |

`mode=js` 时始终返回 `scripts`。`include_links=false` 时不返回 `links`。

### 输出字段

```json
{
  "status": "ok",
  "url_final": "https://example.com/",
  "title": "Example Domain",
  "content": "…",
  "content_type": "text/html",
  "truncated": false,
  "links": [{ "text": "More information...", "url": "https://www.iana.org/domains/example" }],
  "scripts": {
    "external_count": 1,
    "inline_count": 1,
    "external": [{ "src": "https://example.com/app.js", "type": null, "async": false, "defer": false, "module": false }],
    "inline": [{ "index": 0, "chars": 4458, "type": "text/javascript", "flags": ["dom-write"] }],
    "dynamic": { "detected": true, "signals": ["script-dom-write", "content-not-in-source"], "dom_mutations": 0, "post_load_resources": 0 }
  }
}
```

所有错误也走同一对象形状，通过 `status` + `error` 表达，不抛裸异常：

| `error.code` | `status` | 场景 |
|---|---|---|
| `SSRF_BLOCKED` | `blocked` | 回环、私网、链路本地、云元数据、CGNAT 等 |
| `URL_BLOCKED` | `blocked` | 重定向/导航被代理或浏览器策略拦截 |
| `DOMAIN_BLOCKED` / `DOMAIN_NOT_ALLOWED` | `blocked` | 命中拒绝名单或不在白名单 |
| `UNSUPPORTED_PROTOCOL` | `blocked` | `ftp:`、`file:`、`javascript:` 等 |
| `URL_CREDENTIALS` | `blocked` | URL 内含用户名/密码 |
| `PORT_BLOCKED` | `blocked` | 端口不在允许列表 |
| `DOWNLOAD_BLOCKED` | `blocked` | 页面触发下载 |
| `TIMEOUT` | `timeout` | 总时限耗尽 |
| `WAIT_FOR_TIMEOUT` | `timeout` | `wait_for` 选择器未出现 |
| `INVALID_SELECTOR` | `invalid_request` | `wait_for` 不是合法 CSS 选择器 |
| `HTTP_STATUS` | `http_error` | 目标返回 4xx/5xx（保留可提取正文） |
| `UNSUPPORTED_CONTENT_TYPE` | `parse_error` | PDF/图片/音视频/压缩包等 |
| `PARSE_FAILED` | `parse_error` | DOM 提取或 DevTools 求值失败 |
| `BROWSER_UNAVAILABLE` | `browser_error` | 未找到 Edge/Chrome |
| `INTERNAL_ERROR` | `internal_error` | worker 内部失败；不返回堆栈、路径或环境变量 |

---

## 5. 权限与安全策略清单

### 5.1 网络（默认拒绝）

- 只允许 `http:` 和 `https:`；拒绝 `file:`、`ftp:`、`data:`、`javascript:`、`ws:`/`wss:`。
- 只允许显式端口列表（默认 `80`/`443`）。
- 每个请求都在本地代理层重新解析并校验：
  - IPv4：`0.0.0.0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、
    `192.0.0/24`、`192.0.2/24`、`192.88.99/24`、`192.168/16`、`198.18/15`、
    `198.51.100/24`、`203.0.113/24`、`224/4`、`240/4`；
  - IPv6：`::1`、`::/96`、`::ffff:0:0/96`、`64:ff9b::/96`、`64:ff9b:1::/48`、
    `2002::/16`、`2001::/32`、`2001:2::/48`、`2001:10::/28`、`2001:20::/28`、
    `2001:db8::/32`、`3fff::/20`、`5f00::/16`、`fc00::/7`、`fe80::/10`、
    `fec0::/10`、`ff00::/8`；
  - 任一 A/AAAA 记录落在受限范围即拒绝，避免多记录绕过；
  - 云元数据主机名（`metadata.google.internal`、`instance-data` 等）直接拒绝；
  - `169.254.169.254` 单独标记为 `cloud-metadata`。
- 代理**直接连接已校验的 IP**，不在连接阶段重新解析域名，消除 DNS rebinding 窗口。
- 多 A/AAAA 记录中只要有一个受限地址就整体拒绝，防止轮询/回落。
- 重定向和页面内子资源同样经过代理；`http://127.0.0.1`、`http://169.254.169.254`
  以及“公网 302 到元数据地址”都会在代理层被拦截。
- 每个 worker 启动独立代理，只监听 `127.0.0.1` 的随机端口，结束后关闭。
- 浏览器强制 `--proxy-server`，并通过 `--proxy-bypass-list=<-loopback>` 取消本地回环绕行。
- HTTPS 使用 `CONNECT` 透传；TLS 仍由浏览器与目标端到端校验，不做 MITM。
- 代理只放行 `GET`/`HEAD`/`OPTIONS`，拒绝 `POST`/`PUT`/`DELETE`、WebSocket upgrade。
- 请求侧在明文 HTTP 代理层剥离 `Authorization`、`Proxy-Authorization`、`Cookie`、`Cookie2`；
  响应侧剥离 `Set-Cookie`、`Set-Cookie2`、`WWW-Authenticate`。
- HTTPS 由 `CONNECT` 透传，代理看不到隧道内的头；插件不注入任何宿主 cookie/凭据，
  临时浏览器可能持有目标站点自己设置的同源 cookie，但不会回传。
- DevTools `Fetch` 层还会尝试剥离 `Cookie`/`Authorization`；浏览器网络栈可能在拦截后
  重新附加同源 cookie，因此不把它当作 cookie 隔离的唯一保证。
- 不继承宿主的 `HTTP_PROXY`/`HTTPS_PROXY`/API key/DSH 环境变量。

### 5.2 浏览器

- `--headless=new`，每次运行使用 `mkdtemp` 临时 profile，结束删除。
- 禁止下载：`Browser.setDownloadBehavior { behavior: "deny" }`；
  监听 `Page.downloadWillBegin` 并取消。
- 弹窗/额外页面：监听 `Target.targetCreated`，关闭非本页 target。
- 自动拒绝 JS 对话框（`alert`/`confirm`/`prompt`）。
- 关闭通知、定位、权限提示；不授予任何浏览器权限。
- 关闭 WebRTC 非代理 UDP、QUIC、DNS 预取、后台联网、组件更新；启用第三方 Cookie 淘汰测试开关。
- 不加载扩展、不使用持久化 cookie/密码库；每次运行结束删除临时 profile。
- `text`/`html` 模式通过 `Emulation.setScriptExecutionDisabled` 关闭页面 JS；
  只有 `js` 模式执行页面脚本。

### 5.3 进程与文件系统

```
模型
  │  只能看到 web_read JSON Schema
  ▼
Host 插件（lib/index.js）
  │  参数校验 / 并发信号量 / 结果白名单化
  │  spawn(process.execPath, worker/main.mjs)；env 仅允许系统变量
  ▼
独立 worker（无 Harness Service、无工作区、无宿主凭据）
  │  启动本地代理 + 临时 profile 的 Edge/Chrome
  ▼
目标公网（仅经代理）
```

- worker 的 `cwd` 是系统临时目录，环境变量白名单化；
  不传 `DSH_*`、API key、token、用户 home 中的凭据。
- worker 不读取工作区文件，不接收任意代码/脚本/选择器以外的执行参数。
- 临时目录只包含浏览器 profile 和日志，退出时递归删除；删除失败最多重试 6 次。
- 超时/取消：Host 先向 stdin 写入 `{"type":"cancel"}`，给 worker 1.5 秒清理；
  仍未退出则 `taskkill /T /F`（Windows）或 `kill`。
- 结果输出上限 4 MiB；超出直接终止 worker，返回 `RESULT_TOO_LARGE`。

### 5.4 输出内容

- 只返回固定字段：`status/url_final/title/content/content_type/truncated/links?/scripts?/error?`。
- 不回传原始 DOM、`HTMLElement`、事件对象、cookie、localStorage、请求/响应头。
- 内联脚本只返回长度、类型和能力标记，**不返回源码**；worker 内部计算的短 hash 不会进入模型结果。
- HTML 白名单序列化，仅保留 `href/title/datetime/colspan/rowspan`；
  移除所有 `on*` 事件属性、`style`、`src`、`srcset`、`formaction` 等。
- 链接和脚本来历只保留 `http/https`，去掉 URL 内嵌凭据，长度上限 2048。
- `content` 按 UTF-8 字节截断，不切断多字节字符。

### 5.5 已知边界（必须诚实声明）

- 这是**进程级隔离 + 浏览器自身 sandbox**，不是操作系统账户、容器或 Windows Job Object
  级别的强隔离；浏览器 0-day 仍是攻击面。
- HTTPS 隧道内的同源 cookie 由临时浏览器管理，插件不注入、不回传宿主 cookie，但不能把
  浏览器会话完全等同于“无 cookie”。跨域凭证由第三方 Cookie 淘汰开关、无登录态和
  无宿主凭据三重限制共同降低。
- 代理只允许 GET/HEAD/OPTIONS，但 GET 仍可能对设计不良的站点产生副作用；不提供登录、
  表单提交、上传或下载。
- 不解析跨域 iframe、Shadow DOM、Canvas、PDF、图片 OCR。
- Readability 风格算法是启发式；极端布局可能把评论/推荐误判为正文。
- 允许 `http` 是需求要求；不保证明文传输的机密性。
- 目标站在无 cookie/无登录态下可能返回简化页或反爬页。

---

## 6. 实现骨架与沙箱边界

```text
dsh-web-read/
├─ package.json                 # manifest + dsh.bundle.patch + 权限声明
├─ cordis.patch.yml             # insert { id: tool-web-read, name: dsh-web-read }
├─ locale/{zh,en}.json          # Plugin Manager 显示名/描述
├─ icon.svg                     # 原创图标
├─ schema/
│  ├─ web_read.input.json       # 模型可见的输入 Schema
│  └─ web_read.output.json      # 固定输出 Schema
├─ lib/index.js                 # Host：工具注册、参数校验、worker 生命周期
├─ worker/
│  ├─ main.mjs                  # 独立进程入口；stdin/stdout 单请求协议
│  ├─ policy.mjs                # URL/域名/端口/IP 默认拒绝
│  ├─ proxy.mjs                 # 每请求校验的本地 HTTP(S) 代理
│  ├─ browser.mjs               # Edge/Chrome 启动、CDP 页面控制、动态信号
│  ├─ cdp.mjs                   # 最小 DevTools Protocol 客户端
│  ├─ extract.mjs               # 页面内 Readability 风格提取 + HTML 白名单
│  └─ errors.mjs                # 结构化错误
└─ test/
   ├─ policy.test.mjs           # SSRF/协议/端口/域名单元测试
   ├─ host.test.mjs             # 插件契约与 Host 参数拒绝测试
   └─ schema.test.mjs           # DSH JSON Schema 子集校验
```

### 调用链（关键边界）

1. **Host**：`ctx.tools.register()` 只注册 schema 与 `execute`。模型无法访问 `ctx`、
   `process`、文件系统或 worker 路径。
2. **参数闸门**：URL 形状、协议、凭据、字符串长度在 Host 先检查；细粒度 DNS/IP 判断在 worker。
3. **worker**：`startGuardProxy()` → `launchBrowser()` → `navigate()` → `extract()`。
4. **代理**：每个 HTTP 请求/HTTPS CONNECT 都重新 `checkHost`，连接固定 IP。
5. **提取**：页面内执行自包含函数；只把纯 JSON 数据带回 Node。
6. **回传**：worker 再做一次字段裁剪；Host 再做一次白名单化；任一层都不透传内部异常。

### 页面内提取要点

- 候选节点打分：文本长度、标点、段落数、`article/main` 权重、class/id 正负权重、链接密度。
- 移除：`script/style/noscript/template/iframe/object/embed/svg/canvas/video/audio/form/
  button/input/nav/footer/header/aside/dialog/menu`，以及 `hidden`/`aria-hidden`。
- 移除常见广告、cookie、订阅、分享、评论、侧栏、登录、分页等噪声块。
- 文本化时对块级元素插入换行，列表加 `•`，最后压缩空行。
- HTML 只序列化允许标签；所有属性先过白名单。
- 内联脚本只计算 metadata；短 hash 仅供内部去重，不随结果返回。
- 动态信号：
  - `dom-mutated`：DOMContentLoaded 之后的 MutationObserver 计数；
  - `post-load-resources`：DCL 之后仍有资源加载；
  - `script-network-api` / `dynamic-import` / `websocket` / `script-dom-write`：内联脚本能力标记；
  - `content-not-in-source`：渲染后正文与“去掉脚本/样式的原始 HTML”不匹配，说明正文由 JS 生成。

---

## 7. 调用示例

### 7.1 静态正文（text）

```json
{
  "url": "https://example.com/",
  "mode": "text",
  "include_links": true
}
```

返回（省略部分字段）：

```json
{
  "status": "ok",
  "url_final": "https://example.com/",
  "title": "Example Domain",
  "content": "This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.",
  "content_type": "text/html",
  "truncated": false,
  "links": []
}
```

### 7.2 JS 渲染 + 脚本检查（js）

```json
{
  "url": "https://quotes.toscrape.com/js/",
  "mode": "js",
  "wait_for": ".quote",
  "include_links": true,
  "max_bytes": 200000
}
```

关键返回：

```json
{
  "status": "ok",
  "url_final": "https://quotes.toscrape.com/js/",
  "title": "Quotes to Scrape",
  "content": "“The world as we have created it is a process of our thinking…” by Albert Einstein\nTags: change deep-thoughts thinking world\n…",
  "truncated": false,
  "scripts": {
    "external_count": 1,
    "inline_count": 1,
    "external": [
      { "src": "https://quotes.toscrape.com/static/jquery.js", "type": null, "async": false, "defer": false, "module": false }
    ],
    "inline": [
      { "index": 0, "chars": 4458, "type": "text/javascript", "flags": ["dom-write"] }
    ],
    "dynamic": {
      "detected": true,
      "signals": ["script-dom-write", "content-not-in-source"],
      "dom_mutations": 0,
      "post_load_resources": 0
    }
  }
}
```

同一个 URL 用 `mode=text` 时，正文中只有页面框架和链接，没有 10 条 quote——这就是 JS 渲染差异。

### 7.3 错误场景（SSRF 拦截）

```json
{
  "url": "http://169.254.169.254/latest/meta-data/",
  "mode": "text"
}
```

返回：

```json
{
  "status": "blocked",
  "url_final": null,
  "title": null,
  "content": null,
  "content_type": null,
  "truncated": false,
  "error": {
    "code": "SSRF_BLOCKED",
    "message": "目标解析到受限地址（cloud-metadata）。"
  }
}
```

常见同类：

```json
{ "url": "http://127.0.0.1/", "mode": "text" }
```

```json
{
  "status": "blocked",
  "error": { "code": "SSRF_BLOCKED", "message": "目标解析到受限地址（loopback）。" },
  "url_final": null, "title": null, "content": null, "content_type": null, "truncated": false
}
```

---

## 8. 验收测试清单

| # | 检查项 | 期望 | 状态 |
|---|---|---|---|
| 1 | 模型侧可见性 | 只看到 `web_read` schema；看不到 worker、Host API、文件系统 | ✅ 通过 Host 注册测试 |
| 2 | 回环地址 | `http://127.0.0.1/` → `blocked` / `SSRF_BLOCKED` | ✅ 实测 |
| 3 | 云元数据 | `http://169.254.169.254/...` → `blocked` / `cloud-metadata` | ✅ 实测 |
| 4 | 私网/链路本地 | `10/8`、`172.16/12`、`192.168/16`、`fe80::` → 拦截 | ✅ 单元测试 |
| 5 | 非 http(s) | `ftp:`、`file:`、`javascript:` → `UNSUPPORTED_PROTOCOL` | ✅ 单元/实测 |
| 6 | 重定向 SSRF | 公网页 302 到 `169.254.169.254` → `URL_BLOCKED` | ✅ 实测 |
| 7 | JS 渲染 | quotes 页 `mode=js` 得到 10 条 quote；`mode=text` 得不到 | ✅ 实测 |
| 8 | 脚本来源 | `mode=js` 返回 `scripts.external[0].src` 与 `dynamic.detected=true` | ✅ 实测 |
| 9 | `wait_for` | 等到 `.quote` 后提取；非法选择器返回 `INVALID_SELECTOR` | ✅ 实测 |
| 10 | 截断 | `max_bytes=1000` → `truncated=true`，内容不超过 1000 UTF-8 字节 | ✅ 实测 |
| 11 | 超时 | 慢页面 + `timeout_ms=2000` → `timeout` / `TIMEOUT` | ✅ 实测 |
| 12 | HTTP 错误 | 4xx/5xx → `http_error` / `HTTP_STATUS`，保留正文 | 代码路径已覆盖 |
| 13 | 下载/弹窗 | 下载被 deny；新 page target 被关闭；JS 对话框自动取消 | 代码路径；需按站点复测 |
| 14 | Cookie/认证头 | 结果不出现 Cookie/Authorization/Set-Cookie；HTTP 请求头被剥离 | 代码路径 + HTTP 层实测；HTTPS 见 §5.5 |
| 15 | 取消/清理 | `AbortSignal` → cancel → worker 退出 → 临时 profile 删除 | 代码路径；需压力复测 |
| 16 | 并发上限 | 同时最多 `maxConcurrency` 个浏览器 worker | 代码路径；需压力复测 |

> 状态说明：✅ 实测项在开发机上使用 Edge 155 完成；真实浏览器验收需要非受限的 Host 进程。
> 第 12–16 项是代码层保证，建议在目标 profile 再做一次回归。

### 本地测试命令

需要 Node.js 22+。离线单元测试不启动浏览器：

```bash
node --test test/policy.test.mjs test/host.test.mjs test/schema.test.mjs
```

直接调用 worker（需要非受限环境；在文件沙箱中 Chromium 会因命名管道 `EPERM` 退出）：

```powershell
$req = '{"type":"read","url":"https://example.com/","mode":"text","timeout_ms":15000,"max_bytes":200000,"include_links":true,"allowedPorts":[80,443]}'
$req | node .\worker\main.mjs
```

---

## 9. 模型体验

- 工具描述只说明行为、模式、限制和错误字段；不暴露 Edge、CDP、代理、临时目录等实现。
- `mode` 与 `wait_for` 的语义写在参数描述里；模型不需要了解 `web_render`/`js_inspect` 两个内部阶段。
- 所有结果都是可解析 JSON；模型按 `status` / `error.code` / `truncated` 决策，而不是解析自然语言错误。
- `presentCall` 只显示目标主机和模式，不渲染 URL 内的敏感查询参数。
- 结果内容由 Host 再做一次白名单裁剪；未知字段不会进入会话。

---

## 10. 开发与验证

### 浏览器探测

`worker/browser.mjs` 只探测固定安装路径：

- Edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` 等；
- Chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe` 等；
- macOS/Linux 的对应固定路径。

不使用 `PATH` 查找任意同名可执行文件，避免被劫持。

### 关键常量

| 常量 | 值 | 位置 |
|---|---|---|
| 默认超时 | 10000 ms | `schema/web_read.input.json`、Host |
| 最大超时 | 30000 ms | 同上 |
| 默认内容上限 | 200000 bytes | 同上 |
| 最大内容上限 | 1000000 bytes | 同上 |
| 单响应体上限 | 2–8 MiB（HTTP 代理层；HTTPS 由 CDP 计数与总预算约束） | `worker/proxy.mjs` |
| 总传输预算 | 8–32 MiB | `worker/proxy.mjs` |
| 外链上限 | 100 | `extract.mjs`、Host |
| 内联脚本元数据上限 | 30 | 同上 |
| worker 结果上限 | 4 MiB | `lib/index.js` |

### 为什么 `mode=text/html` 仍启动浏览器

它用浏览器的 HTML 解析器构建 DOM，但通过
`Emulation.setScriptExecutionDisabled` 关闭页面脚本。这样 `text` 模式仍然是“静态视图”，
同时避免自己实现一套不完整的 HTML 解析器。代价是每次调用仍有浏览器启动开销（通常为 1–3 秒）。

---

## 11. 许可

MIT。见 `LICENSE`。

插件图标为原创 SVG，随包分发。
