# 数据源完整矩阵

> 按数据类型选择数据源，每类至少 2 个备用。

## 完整矩阵

| 数据类型 | L1 首选 | L2 补充 | L3 参考 |
|---------|---------|---------|---------|
| 港股市值 | Sina Finance | 富途/雪球(浏览器) | Yahoo Finance |
| A股市值 | Sina Finance | 东方财富(浏览器) | 同花顺 |
| 美股市值 | Google Finance | Yahoo Finance | Sina US |
| 北交所市值 | Sina Finance | 巨潮资讯 | 北交所官网 |
| 未上市估值 | Crunchbase(浏览器) | 36氪/量子位 | IT桔子 |
| 财务数据 | 公司财报（巨潮/EDGAR/披露易） | Wind 万得(浏览器) | 券商研报 |
| 招股书 | 港交所披露易 / SEC EDGAR / 巨潮资讯 | 招股说明书 PDF | 媒体摘要 |
| 用户数据 | 公司官方/财报 | QuestMobile / data.ai / Sensor Tower | 第三方估算 |
| 融资数据 | Crunchbase(浏览器) | IT桔子 / Pitchbook | 媒体报道 |
| 行业趋势 | CB Insights / IDC / Gartner | PitchBook / 艾瑞 | 36氪深氪 |
| 市场规模 | Statista / IDC | eMarketer / Frost & Sullivan | 行业报告摘要 |
| 深度独家 | The Information(浏览器) | LatePost 晚点 | TechCrunch / Stratechery |
| 技术路线 | arXiv / Papers w/ Code | GitHub / HuggingFace | 技术博客 |
| 专利数据 | Google Patents / 国知局 / USPTO | WIPO / Espacenet | — |
| 人才动态 | LinkedIn / 脉脉 | 拉勾 / Boss 直聘 JD | 媒体采访 |
| 客户案例 | 公司官网案例页 | G2 / Capterra / Trustpilot | App Store 评论 |
| 政府采购 | 中国政府采购网 / SAM.gov / TED | 各省市公共资源交易中心 | — |
| 监管政策 | 网信办/工信部/总局 / FCC / EU 官网 | 律师事务所行业 alert | 媒体报道 |
| App 数据 | data.ai / Sensor Tower | App Annie / 七麦数据 | App Store / Play Store |
| 论文/会议 | Google Scholar / Semantic Scholar | arXiv / OpenReview | 会议官网 |

## 站点-工具对照表

按抓取方式分类，避免选错工具浪费时间。

| 站点 | 推荐工具 | 备注 |
|------|---------|------|
| 新浪财经 | WebFetch / curl | 静态页面，总股本/近端价格可靠 |
| 巨潮资讯 | WebFetch + Read | 公告 PDF 用 Read |
| 港交所披露易 | WebFetch + Read | 招股书 PDF 用 Read |
| SEC EDGAR | WebFetch | 10-K / 10-Q 文件 |
| 36氪 / 量子位 / 品玩 | WebFetch | 文章页无强反爬 |
| 雪球 | 浏览器 MCP | Cloudflare WAF + JS 反爬 |
| 东方财富 | 浏览器 MCP | JS 反爬强，fetch 全"-" |
| The Information | 浏览器 MCP | 付费墙 + 登录态 |
| Crunchbase | 浏览器 MCP | Cloudflare 防护 |
| IT桔子 | WebFetch（列表）/ 浏览器 MCP（详情） | 详情页需登录 |
| 天眼查 / 企查查 | 浏览器 MCP | 登录态 + 验证码 |
| Google Finance | WebFetch | 价格和基本信息 |
| Yahoo Finance | WebFetch | 部分地区被墙 |
| Bloomberg | 浏览器 MCP | 付费墙 |
| Wind 万得 | API（账号） / 浏览器 MCP | 数据最全 |
| Statista | WebFetch（部分） | 完整数据需订阅 |
| QuestMobile | 浏览器 MCP | 登录 |
| data.ai / Sensor Tower | 浏览器 MCP | 登录或付费 |
| Google Patents | WebFetch | 静态可抓 |
| LinkedIn | 浏览器 MCP | 登录态，反爬严 |
| 脉脉 | 浏览器 MCP | 登录态 |

## 各市场股票代码格式

| 市场 | 代码格式 | 示例 | 新浪 URL |
|------|---------|------|---------|
| 港股 (HK) | 5位数字补零 | 02513=智谱、00100=MiniMax | `hk{5位}/nc.shtml` |
| A股主板 (SH/SZ) | 6位数字 | sh600519=茅台、sz000858=五粮液 | `{sh\|sz}{6位}.html` |
| 创业板 (SZ) | 300xxx | sz300364=中文在线 | `sz{6位}.html` |
| 科创板 (SH) | 688xxx | sh688256=寒武纪、sh688111=金山办公 | `sh{6位}.html` |
| 北交所 (BJ) | 8位数字 | bj830799=艾融软件 | `bj{8位}.html` |
| 美股 (US) | 字母 ticker | AAPL=苹果、NVDA=英伟达 | `usstock/c/{ticker}.shtml` |
| 美股 ADR | 字母 ticker | BABA=阿里、PDD=拼多多 | 同上 |

**注意**：
- 港股代码必须 5 位补零（00100 非 100）
- 科创板 688 开头走上海
- 创业板 300 开头走深圳

## 数据更新频率

| 数据类型 | 更新周期 | 调研有效期 |
|---------|--------|-----------|
| 上市公司市值 | 实时 | 当天 |
| 财报 | 季度 | 当季 |
| 招股书 | 一次性 | 直到 IPO |
| 融资数据 | 不定期 | 6-12 月 |
| 行业报告 | 季度/年度 | 1 年 |
| 用户数据 | 月度 | 1-3 月 |

## 替代源策略

主源不可用时的 fallback：

| 主源 | 备 1 | 备 2 |
|------|------|------|
| Crunchbase | Pitchbook（付费）→ IT桔子（中国）→ 媒体报道 |
| LinkedIn | 脉脉（中国）→ 公司官网 About 页 |
| The Information | 36氪/晚点 → Twitter/X 上的相关爆料 |
| Bloomberg | Reuters → Yahoo Finance |
| QuestMobile | 第三方估算（艾瑞/友盟） → 公司披露 |
