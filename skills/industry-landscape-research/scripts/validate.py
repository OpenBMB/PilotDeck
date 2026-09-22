#!/usr/bin/env python3
"""
Schema 校验脚本 — 检查 data/*.jsonl 与 references/*.json 是否符合 schemas/*.schema.json

用法：
    python scripts/validate.py [--root <package-root>] [--strict]

默认 root = 调研项目根目录（含 data/ 与 schemas/）。

特性：
- 纯标准库（用户偏好），手写极简 JSON Schema 校验器：支持 type / required / properties /
  items / minimum / maximum / enum / pattern / additionalProperties。
- 强制 4 元组检查（datum 子字段）：value + source + as_of + grade。
- 输出：错误数 / 警告数 / 文件 × 行号 × 字段。
- 退出码：0 全部通过 / 1 有错误 / 2 schema 自身损坏。

例：
    python scripts/validate.py --root .
"""
import json
import sys
import re
from pathlib import Path
from typing import Any


def load_json(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def iter_jsonl(path: Path):
    """支持两种格式：
    1. 真正的 JSONL（每行一个对象）
    2. 整个文件就是一个 JSON 对象或数组（教学样本常见）
    """
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    # 尝试整体解析
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            whole = json.loads(stripped)
            if isinstance(whole, list):
                for i, rec in enumerate(whole, 1):
                    yield i, rec
                return
            if isinstance(whole, dict):
                yield 1, whole
                return
        except json.JSONDecodeError:
            pass  # 回落到逐行
    # 逐行 JSONL
    for idx, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            yield idx, json.loads(line)
        except json.JSONDecodeError as e:
            yield idx, ("__error__", str(e))


def check_type(value, expected) -> bool:
    if isinstance(expected, list):
        return any(check_type(value, t) for t in expected)
    mapping = {
        "string": str,
        "integer": int,
        "number": (int, float),
        "boolean": bool,
        "array": list,
        "object": dict,
        "null": type(None),
    }
    py_type = mapping.get(expected)
    if py_type is None:
        return True  # 未知类型放过
    if expected == "integer" and isinstance(value, bool):
        return False
    return isinstance(value, py_type)


def validate(data, schema, path="$", errors=None) -> list:
    if errors is None:
        errors = []

    if "type" in schema and not check_type(data, schema["type"]):
        errors.append(f"{path}: 类型不符，期望 {schema['type']}，实际 {type(data).__name__}")
        return errors

    if "enum" in schema and data not in schema["enum"]:
        errors.append(f"{path}: 值 {data!r} 不在枚举 {schema['enum']}")

    if isinstance(data, dict):
        for req in schema.get("required", []):
            if req not in data:
                errors.append(f"{path}: 缺少必填字段 '{req}'")
        for k, v in data.items():
            sub = schema.get("properties", {}).get(k)
            if sub is not None:
                validate(v, sub, f"{path}.{k}", errors)
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: 未声明字段 '{k}'")

    if isinstance(data, list) and "items" in schema:
        for i, item in enumerate(data):
            validate(item, schema["items"], f"{path}[{i}]", errors)

    if isinstance(data, (int, float)) and not isinstance(data, bool):
        if "minimum" in schema and data < schema["minimum"]:
            errors.append(f"{path}: 值 {data} < minimum {schema['minimum']}")
        if "maximum" in schema and data > schema["maximum"]:
            errors.append(f"{path}: 值 {data} > maximum {schema['maximum']}")

    if isinstance(data, str) and "pattern" in schema:
        if not re.search(schema["pattern"], data):
            errors.append(f"{path}: 字符串不匹配 pattern {schema['pattern']!r}")

    return errors


def check_datum_completeness(data, prefix="$", warnings=None) -> list:
    """强制 4 元组：value + source + as_of + grade。"""
    if warnings is None:
        warnings = []
    if isinstance(data, dict):
        for k, v in data.items():
            new_prefix = f"{prefix}.{k}"
            if isinstance(v, dict) and "datum" in v:
                datum = v["datum"]
                if not isinstance(datum, dict):
                    warnings.append(f"{new_prefix}: datum 不是对象")
                    continue
                missing = [f for f in ("value", "source", "as_of", "grade") if f not in datum]
                if missing:
                    warnings.append(f"{new_prefix}.datum: 缺 4 元组字段 {missing}")
                grade = datum.get("grade")
                if grade and grade not in ("L1", "L2", "L3", "L4"):
                    warnings.append(f"{new_prefix}.datum.grade: 非法等级 {grade}")
            elif isinstance(v, (dict, list)):
                check_datum_completeness(v, new_prefix, warnings)
    elif isinstance(data, list):
        for i, item in enumerate(data):
            check_datum_completeness(item, f"{prefix}[{i}]", warnings)
    return warnings


def main():
    args = sys.argv[1:]
    root = Path(".")
    strict = False
    if "--root" in args:
        i = args.index("--root")
        root = Path(args[i + 1])
    if "--strict" in args:
        strict = True

    schemas_dir = root / "schemas"
    data_dir = root / "data"
    examples_dir = root / "examples"

    if not schemas_dir.exists():
        print(f"[FATAL] schemas 目录不存在: {schemas_dir}", file=sys.stderr)
        sys.exit(2)

    try:
        company_schema = load_json(schemas_dir / "company.schema.json")
        event_schema = load_json(schemas_dir / "event.schema.json")
        racetrack_schema = load_json(schemas_dir / "racetrack.schema.json")
        source_schema = load_json(schemas_dir / "source.schema.json")
        sku_schema_path = schemas_dir / "sku.schema.json"
        sku_schema = load_json(sku_schema_path) if sku_schema_path.exists() else None
    except Exception as e:
        print(f"[FATAL] schemas 自身解析失败: {e}", file=sys.stderr)
        sys.exit(2)

    schema_map = {
        "companies": company_schema,
        "events": event_schema,
        "racetracks": racetrack_schema,
    }
    if sku_schema is not None:
        schema_map["skus"] = sku_schema

    total_errors = 0
    total_warnings = 0

    # 扫描 data/ 与 examples/*/
    targets = []
    for d in (data_dir, examples_dir):
        if d.exists():
            for f in d.rglob("*.jsonl"):
                targets.append(f)

    if not targets:
        print("[INFO] 未找到 .jsonl 文件，跳过数据校验", file=sys.stderr)

    for f in targets:
        # 根据文件名推断 schema
        stem = f.stem.replace("-sample", "")
        schema_key = None
        for key in schema_map:
            if key.rstrip("s") in stem or key in stem:
                schema_key = key
                break
        if schema_key is None:
            print(f"[SKIP] {f}: 无法推断 schema（文件名应含 companies/events/racetracks/skus）")
            continue

        schema = schema_map[schema_key]
        file_errors = 0
        file_warnings = 0

        # examples/ 下视为教学样本，schema 不全只是 WARN；data/ 下严格 ERROR
        is_example = "examples" in f.parts
        for idx, record in iter_jsonl(f):
            if isinstance(record, tuple) and record[0] == "__error__":
                print(f"[ERROR] {f}:{idx} JSON 解析失败: {record[1]}")
                file_errors += 1
                continue
            errs = validate(record, schema)
            warns = check_datum_completeness(record)
            for e in errs:
                if is_example:
                    print(f"[WARN ] {f}:{idx} (example) {e}")
                    file_warnings += 1
                else:
                    print(f"[ERROR] {f}:{idx} {e}")
                    file_errors += 1
            for w in warns:
                print(f"[WARN ] {f}:{idx} {w}")
                file_warnings += 1

        print(f"  → {f.name}: {file_errors} errors / {file_warnings} warnings")
        total_errors += file_errors
        total_warnings += file_warnings

    # 校验 sources.csv 存在与基础格式
    sources_csv = data_dir / "sources.csv"
    if sources_csv.exists():
        with open(sources_csv, "r", encoding="utf-8") as f:
            header = f.readline().strip().split(",")
            required = {"url", "as_of", "grade"}
            missing = required - set(header)
            if missing:
                print(f"[ERROR] sources.csv 表头缺字段: {missing}")
                total_errors += 1

    print(f"\n========= 总结 =========")
    print(f"Errors  : {total_errors}")
    print(f"Warnings: {total_warnings}")
    if total_errors > 0:
        sys.exit(1)
    if strict and total_warnings > 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
