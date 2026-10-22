# 估值追踪 Playbook

> 各市场估值获取的完整 SOP，含双值展示、未上市公司估值、数据等级标注。

## 上市公司市值获取

### 港股 (HK)
```
URL: https://finance.sina.com.cn/realstock/company/hk{5位代码}/nc.shtml
示例: hk02513 = 智谱AI、hk00100 = MiniMax
```
- 页面含 `@fixTotalShare@` 总股本字段，静态可抓
- 实时股价需 JS 渲染，WebFetch 可能拿不到 → 用近 5 日收盘价 × 总股本估算
- 港股代码格式：5位数字补零（00100 非 100）

### A 股 (SZ/SH)
```
URL: https://finance.sina.com.cn/realstock/company/{sz|sh}{6位代码}.html
示例: sz300364 = 中文在线、sh600519 = 贵州茅台
```
- 同上，总股本可靠，价格需动态渲染
- 估算公式：市值 = 总股本 × 近端价格

### 美股 (US)
```
URL: https://finance.sina.com.cn/stock/usstock/c/{ticker}.shtml
或: https://www.google.com/finance/quote/{ticker}:NASDAQ
```

### 北交所 (BJ)
```
URL: https://finance.sina.com.cn/realstock/company/bj{8位代码}.html
```

### 科创板 / 创业板
- 科创板 688xxx 走上海，URL 同 A 股 SH
- 创业板 300xxx 走深圳，URL 同 A 股 SZ

## 未上市公司估值（按可信度降序）

### 方法 1: 最近一轮融资估值（L1-L2）
- Crunchbase 估值字段
- IT 桔子 / Pitchbook
- 公司官方公告
- 媒体引用"估值达 $X 亿"

### 方法 2: 招股书披露（L1）
- 港股递表文件中"估值"章节
- SEC S-1 招股书

### 方法 3: 对标推算（L3）
- 同赛道同阶段公司的 PS / EV/EBITDA 倍数
- 公式：估值 = ARR × 同业 PS

### 方法 4: 传闻信源（L4）
- 匿名消息源
- 二级市场基金组合估值快照
- 行业自媒体

## 数据等级（L1-L4）

| 等级 | 含义 | 标注 |
|------|------|------|
| L1 | 交易所实时报价 / 招股书披露 | 直接使用 |
| L2 | 总股本 × 近端价格 / 权威媒体引用的融资估值 | 直接使用 |
| L3 | 对标推算 / 过期数据外推 | 标 `~` 或 `(估)` |
| L4 | 匿名消息源 / 自媒体爆料 | 标 `(传)` 或 `(未证实)` |

## 双值展示规范

用户要求"首日 + 当前"时，同时展示：

| 字段 | 来源 |
|------|------|
| 上市首日市值 | 发行价 × 总股本（含首日涨幅） |
| 当前市值 | 标注截止日期（如"6/22"） |
| 峰值市值（可选） | 历史最高，如"峰值 2635 亿港元" |

格式示例：
> 首日 2635 亿港元 → 当前 2221 亿港元（截止 6/22，峰值 2635 亿）

## 货币换算与口径

调研启动时记录基准汇率快照（详见 Charter 第 9 节）。

| 货币对 | 截至 2026-06-24 |
|--------|---------------|
| USD/CNY | 7.12 |
| HKD/CNY | 0.91 |
| EUR/CNY | 7.65 |

排行榜必须统一货币（推荐人民币亿元）。同时标注原币种。

## 估值排行榜（国内/海外分轨）

全球化行业必须分两个排行榜，禁止混排：

**国内 TOP N**（按人民币亿元降序）：
- 上市公司：股票代码 + 双值
- 未上市：融资轮次 + 估值

**海外 TOP N**（按美元亿降序）：
- 同上

### 排行榜模板字段

| 字段 | 必填 |
|------|------|
| 排名 | ✓ |
| 公司名（中英） | ✓ |
| 股票代码 / 状态 | ✓ |
| 估值/市值（亿元/亿美元） | ✓ |
| 截止日期 | ✓ |
| 数据等级（L1-L4） | ✓ |
| 来源 URL | ✓ |
| 子生态层（如适用） | 推荐 |
| 地理（如适用） | 推荐 |

## 已上市 vs 未上市混排陷阱

- 上市公司：实时市值，每天波动
- 未上市公司：上一轮融资估值，可能已过 1-2 年

混排会让"未上市估值"看起来比"上市市值"大，因为没人去 markdown。

**正确做法**：分两列展示，或强制为未上市加 "(上一轮 YYYY-MM)" 后缀。

## 估值有效期

| 类型 | 有效期 |
|------|--------|
| 上市公司市值 | 当天 |
| 未上市最近一轮 | 6-12 月 |
| 招股书估值 | IPO 前 1-3 月 |
| 对标推算 | 1-3 月 |

超期数据必须标"(数据可能过期)"。

## 价格抓取代码片段

```python
# 港股市值估算
import re
import urllib.request

def get_hk_market_cap(code: str):
    """估算港股市值（总股本 × 近端价格）"""
    code_padded = code.zfill(5)
    url = f"https://finance.sina.com.cn/realstock/company/hk{code_padded}/nc.shtml"
    html = urllib.request.urlopen(url).read().decode("utf-8")

    # 总股本
    share_match = re.search(r"@fixTotalShare@(\d+\.?\d*)", html)
    total_share = float(share_match.group(1)) if share_match else None

    # 近端价格（从 K 线数据 fallback）
    price_match = re.search(r"@now@(\d+\.?\d*)", html)
    price = float(price_match.group(1)) if price_match else None

    if total_share and price:
        return total_share * price
    return None
```

## 反模式

- ❌ 把 GMV 当营收 → 永远不一致
- ❌ 把"最近一轮投后估值"当"实时估值" → 没有 markdown
- ❌ 港股代码不补零（写 2513 而非 02513） → 数据找不到
- ❌ 美股 ADR 当美股本体看 → 估值口径错误
- ❌ 上市/未上市混排不区分 → 一眼看不出"哪个是即时数字"
