
from __future__ import annotations

import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent
ENV_FILE = ROOT / ".env"
MODELS_PY = ROOT / "og" / "config" / "models.py"


RESET = "\033[0m"
BOLD  = "\033[1m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED   = "\033[31m"
CYAN  = "\033[36m"
DIM   = "\033[2m"

def c(text: str, color: str) -> str:
    return f"{color}{text}{RESET}" if sys.stdout.isatty() else text


PROVIDERS = [
    {
        "label":       "DeepSeek",
        "env_key":     "DEEPSEEK_API_KEY",
        "models_var":  "_DEFAULT_API_KEY",
        "prefix":      "sk-",
        "required":    True,
        "validate":    "balance",
        "balance_url": "https://api.deepseek.com/user/balance",
        "ping_url":    None,
        "models":      ["deepseek-v4-pro", "deepseek-v4-flash"],
        "hint":        "DeepSeek 控制台 → https://platform.deepseek.com/api_keys",
    },
    {
        "label":       "Doubao / 火山方舟",
        "env_key":     "DOUBAO_API_KEY",
        "models_var":  "_DOUBAO_API_KEY",
        "prefix":      "ark-",
        "required":    False,
        "validate":    "ping",
        "balance_url": None,
        "ping_url":    "https://ark.cn-beijing.volces.com/api/v3/models",
        "models":      ["doubao-seed-2-0-pro-260215"],
        "hint":        "火山方舟控制台 → https://console.volcengine.com/ark",
    },
    {
        "label":       "Qwen / DashScope",
        "env_key":     "QWEN_API_KEY",
        "models_var":  "_QWEN_API_KEY",
        "prefix":      "sk-",
        "required":    False,
        "validate":    "ping",
        "balance_url": None,
        "ping_url":    "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
        "models":      ["qwen3-7b-plus", "qwen-plus", "qwen-turbo"],
        "hint":        "阿里云 DashScope → https://dashscope.console.aliyun.com/apiKey",
    },
    {
        "label":       "MiniMax",
        "env_key":     "MINIMAX_API_KEY",
        "models_var":  "_MINIMAX_API_KEY",
        "prefix":      "sk-",
        "required":    False,
        "validate":    "ping",
        "balance_url": None,
        "ping_url":    "https://api.minimaxi.com/v1/models",
        "models":      ["MiniMax-M3"],
        "hint":        "MiniMax 开放平台 → https://platform.minimaxi.com",
    },
    {
        "label":       "YeysAI（gemini / gpt-4o / claude）",
        "env_key":     "YEYSAI_API_KEY",
        "models_var":  "_YEYSAI_API_KEY",
        "prefix":      "sk-",
        "required":    False,
        "validate":    "ping",
        "balance_url": None,
        "ping_url":    "https://yeysai.com/v1/models",
        "models":      ["gemini-2.5-pro", "gpt-4o", "claude-sonnet-4-5"],
        "hint":        "YeysAI 聚合接口（联系管理员获取 key）",
    },
]

MODEL_ROLES = [
    {
        "env": "LLM_MAIN",
        "label": "LLM_MAIN  （主管道：build / update / curation / polish）",
        "default": "deepseek-v4-pro",
        "examples": ["deepseek-v4-pro", "qwen-plus", "doubao-seed-2-0-pro-260215", "MiniMax-M3"],
    },
    {
        "env": "LLM_UTIL",
        "label": "LLM_UTIL  （辅助任务：翻译 / 关键词抽取 / JSON 清洗）",
        "default": "deepseek-v4-flash",
        "examples": ["deepseek-v4-flash", "qwen-turbo"],
    },
    {
        "env": "LLM_JUDGE",
        "label": "LLM_JUDGE （RACE 评测裁判，建议与 LLM_MAIN 不同家族）",
        "default": "deepseek-v4-flash",
        "examples": ["deepseek-v4-flash", "qwen-turbo", "gemini-2.5-pro"],
    },
]



def load_env() -> dict[str, str]:
    result: dict[str, str] = {}
    if not ENV_FILE.exists():
        return result
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        result[k.strip()] = v.strip().strip('"').strip("'")
    return result


def write_env(env: dict[str, str]) -> None:
    lines: list[str] = []
    if ENV_FILE.exists():
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()

    written: set[str] = set()


    new_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#") or not stripped or "=" not in stripped:
            new_lines.append(line)
            continue
        k, _, _ = stripped.partition("=")
        k = k.strip()
        if k in env:
            new_lines.append(f"{k}={env[k]}")
            written.add(k)
        else:
            new_lines.append(line)


    for k, v in env.items():
        if k not in written:
            new_lines.append(f"{k}={v}")

    ENV_FILE.write_text("\n".join(new_lines) + "\n", encoding="utf-8")


def get_models_py_value(var_name: str) -> str:
    if not MODELS_PY.exists():
        return ""
    for line in MODELS_PY.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if var_name in stripped:
            m = re.search(r'["\']([^"\']{4,})["\']', stripped)
            if m:
                return m.group(1)
    return ""


def effective_key(provider: dict, env: dict[str, str]) -> str:
    return env.get(provider["env_key"], "") or get_models_py_value(provider["models_var"])


def mask(key: str) -> str:
    if len(key) <= 12:
        return "***"
    return key[:8] + "***" + key[-4:]



def check_deepseek_balance(key: str) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(
            "https://api.deepseek.com/user/balance",
            headers={"Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read())
        balance = data.get("balance_infos", [{}])[0].get("total_balance", "N/A")
        available = data.get("is_available", "?")
        return True, f"余额: ¥{balance}  可用: {available}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)[:60]


def ping_api(url: str, key: str) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            code = resp.status
        return code == 200, f"HTTP {code}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)[:60]


def validate_provider(provider: dict, key: str) -> tuple[bool, str]:
    if not key:
        return False, "未配置"
    if provider["validate"] == "balance" and provider["balance_url"]:
        return check_deepseek_balance(key)
    if provider["validate"] == "ping" and provider["ping_url"]:
        return ping_api(provider["ping_url"], key)
    return True, "跳过验证"



def prompt_key(label: str, current: str, prefix: str, hint: str) -> Optional[str]:
    status = c(f"已设置: {mask(current)}", GREEN) if current else c("未设置", DIM)
    print(f"\n  {c(label, BOLD)}")
    print(f"  当前状态: {status}")
    print(f"  {c('→ ' + hint, DIM)}")
    raw = getpass.getpass(f"  输入新 key（前缀 {prefix}，Enter 跳过）: ").strip()
    if not raw:
        return None
    if not raw.startswith(prefix):
        print(c(f"  ⚠  key 应以 {prefix!r} 开头，已原样保存", YELLOW))
    return raw


def prompt_model(role: dict, env: dict[str, str]) -> Optional[str]:
    current = env.get(role["env"], "") or role["default"]
    examples = "  |  ".join(role["examples"])
    print(f"\n  {c(role['label'], BOLD)}")
    print(f"  当前: {c(current, CYAN)}    可选: {c(examples, DIM)}")
    raw = input("  输入模型名（Enter 保持不变）: ").strip()
    return raw if raw else None



def cmd_show() -> None:
    env = load_env()
    print(f"\n{c('─' * 56, DIM)}")
    print(c("  当前 API Key 配置（脱敏）", BOLD))
    print(c("─" * 56, DIM))
    for p in PROVIDERS:
        key = effective_key(p, env)
        status = c(mask(key), GREEN) if key else c("未配置", DIM)
        req = "" if not p["required"] else c(" [必需]", RED)
        print(f"  {p['label']:<28}{status}{req}")
    print(f"\n{c('  模型角色', BOLD)}")
    for r in MODEL_ROLES:
        val = env.get(r["env"]) or r["default"]
        src = "(env)" if r["env"] in env else "(默认)"
        print(f"  {r['env']:<12} = {c(val, CYAN)} {c(src, DIM)}")
    print()


def cmd_check() -> None:
    env = load_env()
    print(f"\n{c('─' * 56, DIM)}")
    print(c("  API 连通性验证", BOLD))
    print(c("─" * 56, DIM))
    all_ok = True
    for p in PROVIDERS:
        key = effective_key(p, env)
        if not key:
            if p["required"]:
                print(f"  {c('✗', RED)} {p['label']:<28} 未配置（必需）")
                all_ok = False
            else:
                print(f"  {c('○', DIM)} {p['label']:<28} 未配置（跳过）")
            continue
        print(f"  {c('…', YELLOW)} {p['label']:<28} 验证中...", end="\r")
        ok, msg = validate_provider(p, key)
        icon = c("✓", GREEN) if ok else c("✗", RED)
        key_info = c(mask(key), DIM)
        print(f"  {icon} {p['label']:<28} {msg}  {key_info}    ")
        if not ok:
            all_ok = False
    print()
    if all_ok:
        print(c("  ✓ 所有已配置接口验证通过", GREEN))
    else:
        print(c("  ⚠  部分接口验证失败，请检查 key 或网络", YELLOW))
    print()


def cmd_setup() -> None:
    env = load_env()
    is_new = not ENV_FILE.exists()

    print(f"\n{c('═' * 56, BOLD)}")
    print(c("  og_impl_v6  配置向导", BOLD))
    print(c("═" * 56, BOLD))
    if is_new:
        print(c("  ℹ  未检测到 .env，将新建", CYAN))
    else:
        print(f"  ℹ  已加载 {ENV_FILE}")
    print(f"\n  {c('提示', DIM)}: 直接 Enter 跳过该项（保持现有值）")
    print(f"  {c('提示', DIM)}: key 输入时不回显（安全）\n")


    print(c("  ┌─ Step 1 / 3  API Keys ─────────────────────────────┐", BOLD))
    changed_keys: dict[str, str] = {}
    for p in PROVIDERS:
        req_mark = c(" *必需*", RED) if p["required"] else ""
        new_val = prompt_key(
            p["label"] + req_mark,
            effective_key(p, env),
            p["prefix"],
            p["hint"],
        )
        if new_val:
            changed_keys[p["env_key"]] = new_val


    print(f"\n{c('  ┌─ Step 2 / 3  模型角色 ─────────────────────────────┐', BOLD)}")
    changed_models: dict[str, str] = {}
    for role in MODEL_ROLES:
        new_val = prompt_model(role, env)
        if new_val:
            changed_models[role["env"]] = new_val


    print(f"\n{c('  ┌─ Step 3 / 3  写入 & 验证 ──────────────────────────┐', BOLD)}")
    if not changed_keys and not changed_models:
        print(c("  ○  无更改，跳过写入", DIM))
    else:
        env.update(changed_keys)
        env.update(changed_models)
        write_env(env)
        print(c(f"  ✓  已写入 {ENV_FILE}", GREEN))
        for k in list(changed_keys) + list(changed_models):
            val = env[k]
            display = mask(val) if k.endswith("_KEY") else val
            print(f"     {k} = {display}")


    print()
    do_check = input("  是否立即验证所有 API 接口？[Y/n] ").strip().lower()
    if do_check in ("", "y", "yes"):
        cmd_check()
    else:
        print()
        print(c("  稍后可运行:  python setup.py --check", DIM))
        print()




def main() -> None:
    args = sys.argv[1:]
    if "--check" in args:
        cmd_check()
    elif "--show" in args:
        cmd_show()
    elif "--template" in args:
        template = ROOT / ".env.template"
        if template.exists():
            print(template.read_text())
        else:
            print("未找到 .env.template")
    elif "--help" in args or "-h" in args:
        print(__doc__)
    else:
        cmd_setup()


if __name__ == "__main__":
    main()
