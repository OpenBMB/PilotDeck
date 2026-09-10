#!/usr/bin/env python3
"""
单位经济学批量计算器
- 纯标准库实现（用户偏好：拒绝额外 pip 依赖）
- 输入：companies.jsonl（按 schemas/company.schema.json）
- 输出：CSV + Markdown 表格

用法：
    python unit-economics-calculator.py <companies.jsonl> [--out out.csv]

例：
    python unit-economics-calculator.py ../../examples/ex-saas-legaltech/companies-sample.jsonl
"""
import json
import sys
import csv
from pathlib import Path


def safe(d, *keys, default=None):
    """从嵌套字典安全取值。"""
    cur = d
    for k in keys:
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return default
    return cur


def datum_value(field):
    """field 可能是 {datum:{value,...}} 或 直接 数字。"""
    if isinstance(field, dict) and "datum" in field:
        return field["datum"].get("value")
    if isinstance(field, (int, float)):
        return field
    return None


def calc_unit_economics(company):
    """根据 company 字段算出能算的指标。缺数据则填 None。"""
    arpu = datum_value(company.get("arpu"))
    margin = datum_value(company.get("gross_margin"))
    churn = datum_value(company.get("monthly_churn"))
    cac = datum_value(company.get("cac"))
    new_cust = datum_value(company.get("new_customers"))
    sm_spend = datum_value(company.get("sm_spend"))
    begin_arr = datum_value(company.get("beginning_arr"))
    end_arr = datum_value(company.get("ending_arr"))
    churned_arr = datum_value(company.get("churned_arr"))
    net_loss = datum_value(company.get("net_loss"))
    ebitda = datum_value(company.get("ebitda_margin"))
    growth = datum_value(company.get("revenue_growth_yoy"))
    nrr_explicit = datum_value(company.get("nrr"))

    out = {}

    # LTV / CAC
    if arpu is not None and margin is not None and churn:
        out["LTV"] = round(arpu * (margin / 100) / (churn / 100), 0)
    if cac is None and sm_spend is not None and new_cust:
        cac = round(sm_spend / new_cust, 0)
    if cac is not None:
        out["CAC"] = cac
    if "LTV" in out and cac:
        out["LTV/CAC"] = round(out["LTV"] / cac, 2)
        out["CAC_Payback_月"] = (
            round(cac / (arpu * margin / 100), 1)
            if arpu and margin
            else None
        )

    # ARR-based metrics
    if begin_arr and end_arr and sm_spend:
        out["Magic_Number"] = round((end_arr - begin_arr) / sm_spend, 2)
    if begin_arr and end_arr and churned_arr is not None:
        out["GRR"] = round((end_arr - churned_arr) / begin_arr * 100, 1)
    if nrr_explicit is not None:
        out["NRR"] = nrr_explicit
    elif begin_arr and end_arr and churned_arr is not None:
        out["NRR_approx"] = round((end_arr - churned_arr) / begin_arr * 100, 1)

    # Rule of 40 / Burn Multiple
    if growth is not None and ebitda is not None:
        out["Rule_of_40"] = round(growth + ebitda, 1)
    if net_loss and end_arr and begin_arr and (end_arr - begin_arr) > 0:
        out["Burn_Multiple"] = round(net_loss / (end_arr - begin_arr), 2)

    return out


def verdict(metrics):
    """简易健康判定。"""
    flags = []
    if metrics.get("LTV/CAC") and metrics["LTV/CAC"] < 3:
        flags.append("LTV/CAC<3")
    if metrics.get("CAC_Payback_月") and metrics["CAC_Payback_月"] > 24:
        flags.append("payback>24m")
    if metrics.get("Rule_of_40") and metrics["Rule_of_40"] < 30:
        flags.append("Rule<30")
    if metrics.get("Burn_Multiple") and metrics["Burn_Multiple"] > 2:
        flags.append("burn>2")
    if not flags:
        return "🟢 Healthy"
    if len(flags) <= 1:
        return f"🟡 Watch ({','.join(flags)})"
    return f"🔴 Risk ({','.join(flags)})"


def main(jsonl_path, out_csv="unit-economics-out.csv"):
    rows = []
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            company = json.loads(line)
            metrics = calc_unit_economics(company)
            metrics["company_id"] = company.get("company_id")
            metrics["name"] = company.get("name")
            metrics["verdict"] = verdict(metrics)
            rows.append(metrics)

    # 输出 CSV
    all_keys = sorted({k for r in rows for k in r.keys()})
    leading = ["company_id", "name", "verdict"]
    headers = leading + [k for k in all_keys if k not in leading]

    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for r in rows:
            writer.writerow(r)

    # 控制台 Markdown 输出
    print("| " + " | ".join(headers) + " |")
    print("|" + "|".join(["---"] * len(headers)) + "|")
    for r in rows:
        print("| " + " | ".join(str(r.get(k, "")) for k in headers) + " |")

    print(f"\n✓ 写入 {out_csv}（{len(rows)} 家公司）", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    args = sys.argv[1:]
    out = "unit-economics-out.csv"
    if "--out" in args:
        i = args.index("--out")
        out = args[i + 1]
        args = args[:i] + args[i + 2:]

    main(args[0], out)
