# 反爬绕路策略

> 选错抓取方式会浪费大量时间。本文件给出按站点分类的策略，以及通用绕路技巧。

## 通用规则

1. **先试 WebFetch / curl**，拿到空数据或"-"再切浏览器 MCP
2. **JS 动态字段**（如 `@now@`、`@fixTotalShare@`）WebFetch 拿不到 → 用"总股本 × 近端价格"绕路
3. **付费墙**优先找公开摘要 / 二手引用，非必要时不开浏览器登录
4. **高频反爬**站点用慢速节流（每 20 条 pause 1s）

## 站点策略表

详见 `references/source-matrix.md` 的"站点-工具对照表"。

## 反爬场景速查

### 场景 1: 总市值需要 JS 渲染（雪球 / 东方财富）

**症状**：fetch 拿到的页面里数字全是 "-" 或 "{{ price }}"

**绕路**：
1. 切到新浪财经同公司页（静态可抓）
2. 抓总股本 `@fixTotalShare@`
3. 抓近 5 日收盘价
4. 计算：市值 = 总股本 × 近端价格
5. 标注"估算"+ 日期

### 场景 2: Cloudflare 防护（Crunchbase / The Information）

**症状**：fetch 返回 403 / 5xx，或 HTML 里只有 challenge 页

**绕路**：
1. 优先用浏览器 MCP（带 cookie）
2. 找 archive.org Wayback Machine 的快照
3. 用 Google 缓存
4. 找权威媒体二次引用（如 36氪/晚点引用 Crunchbase 数据）

### 场景 3: 付费墙（Bloomberg / Information / Wind）

**症状**：HTML 里只有标题和前几段

**绕路**：
1. 找开放的二次引用（媒体经常引用 Bloomberg / Information 的爆料）
2. 找作者的 Twitter/X 主页，常有摘要
3. 内部团队有订阅 → 浏览器 MCP + 已登录账号

### 场景 4: 登录态 + 验证码（天眼查 / LinkedIn）

**症状**：列表页可看，详情页需登录

**绕路**：
1. 中文公司 → 国家信用信息公示系统（免登录）
2. LinkedIn → 公司官网 About 页 + 媒体采访
3. 天眼查 → 企查查 / 启信宝（部分免费）

### 场景 5: PDF 文件（招股书 / 财报）

**症状**：URL 是 .pdf，需要下载

**绕路**：
1. 用 Read 工具（支持 PDF 阅读）
2. 大 PDF（>10 页）必须指定 pages 参数
3. 找 HTML 版（如 SEC EDGAR 同公司常有 HTML 报告）
4. 找媒体摘要（如"招股书要点解读"）

### 场景 6: SPA 动态加载（社交 / 即时通讯）

**症状**：HTML 是空的 div，内容靠 JS 后加载

**绕路**：
1. 浏览器 MCP 等加载完成后再 read_page
2. 找接口：F12 Network 看哪个 API 返回数据，直接 curl 那个 API
3. 通过手机端 H5 入口（常常反爬更弱）

### 场景 7: 内嵌 iframe 跨域（鲲鹏 CRM 等内部系统）

**症状**：父页面 JS 无法访问 iframe 内数据

**绕路**：
1. 直接抓 iframe 的 URL
2. 抓 iframe 调用的后端 API
3. 用 browser computer use 逐点点击 ECharts 数据点提取 tooltip

## 节流策略

| 站点类型 | 推荐节流 |
|---------|---------|
| 高反爬（雪球/东方财富） | 每请求 pause 3-5s |
| 中反爬（新浪/36氪） | 每 10 请求 pause 1s |
| 低反爬（公司官网） | 每 30 请求 pause 1s |

并发：单站点同时 ≤ 3 个连接，避免触发封 IP。

## 内容截断处理

WebFetch 经常截断长 HTML：

1. 用 `curl + grep` 直接定位关键段
2. 用 `mcp__builtin_browser__javascript_tool` 在浏览器内 querySelector 取值
3. 分段抓：第一次抓 0-50KB，第二次 50-100KB...

JavaScript tool 返回 > 50KB 时分块取回 + 利用自动持久化的 tmp 文件拼装。

## 浏览器 MCP 限制

- **无法导航本地 file:// URL** → 验证本地 HTML 须用 Bash `open` 命令
- **JS 长结果**（>50KB）自动持久化到 tmp 文件，cp 出来用
- **截图大小**：单页面 > 2MB 时分屏截

## 失败重试

1. 第 1 次失败 → 立即重试 1 次
2. 第 2 次失败 → pause 30s 后重试
3. 第 3 次失败 → 切到备用源
4. 三次都失败 → 标 "数据不足" + 该字段降 L4

禁止陷入死循环重试。
