from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .memory import read_memory_file, MEMORY_ROOT
from .preferences import get_all_preferences
from .. import filestore

router = APIRouter(prefix="/chat", tags=["chat"])


ROOT       = Path(__file__).resolve().parents[2]
CONV_DIR   = MEMORY_ROOT / "conversations"
INDEX_PATH = CONV_DIR / "index.json"
CONV_DIR.mkdir(parents=True, exist_ok=True)




def _get_tools():
    try:
        from . import chat_tools
        return chat_tools.TOOL_DEFINITIONS
    except ImportError:
        return []


def _execute_tool(name: str, args: dict) -> Any:
    try:
        from . import chat_tools
        return chat_tools.execute(name, args)
    except ImportError:
        return {"error": "工具模块尚未加载"}




def _conv_path(conv_id: str) -> Path:
    return CONV_DIR / f"{conv_id}.json"


def _load_index() -> list[dict]:
    if INDEX_PATH.exists():
        try:
            return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return []


def _save_index(index: list[dict]) -> None:
    INDEX_PATH.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_conv(conv_id: str) -> dict | None:
    p = _conv_path(conv_id)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def _save_conv(conv: dict) -> None:
    conv["updated_at"] = datetime.now(timezone.utc).isoformat()
    _conv_path(conv["id"]).write_text(
        json.dumps(conv, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    index = _load_index()
    entry = {
        "id": conv["id"], "cluster_id": conv.get("cluster_id"),
        "title": conv.get("title", ""), "model": conv.get("model", ""),
        "msg_count": len(conv.get("messages", [])),
        "updated_at": conv["updated_at"],
    }
    index = [e for e in index if e["id"] != conv["id"]]
    index.insert(0, entry)
    _save_index(index)


def _new_conv(cluster_id: Optional[str], model: str) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "cluster_id": cluster_id,
        "title": "",
        "model": model,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "messages": [],
    }




def _build_system_prompt(cluster_id: Optional[str], context: dict,
                         prefs: dict) -> str:


    from .memory import local_memory_enabled
    if local_memory_enabled():
        global_mem  = read_memory_file("global")
        user_mem    = read_memory_file("user")
        cluster_mem = read_memory_file("project", cluster_id) if cluster_id else ""
    else:
        global_mem = user_mem = cluster_mem = ""

    memory_parts = []
    if global_mem: memory_parts.append(f"## 全局知识\n{global_mem}")
    if user_mem:   memory_parts.append(f"## 用户偏好与习惯\n{user_mem}")
    if cluster_mem: memory_parts.append(f"## {cluster_id} 项目记忆\n{cluster_mem}")
    memory_ctx = "\n\n".join(memory_parts) or "（记忆库暂为空）"


    cluster_topic = ""
    if cluster_id:
        cfg = filestore.read_cluster_config(cluster_id) or {}
        cluster_topic = cfg.get("topic", "")

    expertise = prefs.get("expertise_level", "researcher")
    lang_note  = "请用中文回复。" if prefs.get("response_language", "zh") == "zh" else "Please reply in English."
    exp_note   = {
        "beginner":    "用通俗语言解释，多举例。",
        "researcher":  "专业简洁，省略基础概念。",
        "expert":      "直接输出技术细节，无需解释。",
    }.get(expertise, "")

    tab     = context.get("tab", "—")
    version = context.get("version", "—")
    node    = context.get("selected_node_id", "")
    node_line = f"\n- 当前选中节点: {node}" if node else ""

    return f"""你是 og_impl_v6 的专属 AI 研究助手。

og 是一个增量知识图谱系统（OutlineGraph），通过多个 LLM Agent 从参考文献
构建知识图谱，支持多版本迭代，最终生成研究报告。

## 当前上下文
- 集群: {cluster_id or '未选择'}{f' — {cluster_topic}' if cluster_topic else ''}
- 当前 Tab: {tab} | 图谱版本: {version}{node_line}

---
{memory_ctx}
---

## 行为规范
1. 执行有副作用的操作（如启动流水线）前，必须先确认用户意图
2. 用户说"记住"或"记录一下" → 调用 write_memory 工具
3. 用户修改偏好（"我以后用 X"、"记住默认用 X"）→ 调用 set_preference 工具
4. 报告/图谱内容较长时，摘要展示而不是全文复读
5. {lang_note} {exp_note}
"""




def _get_llm_client(model: str):
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from og.config.models import get_client_for_model
    return get_client_for_model(model, timeout=60.0)


async def _stream_llm(messages: list[dict], model: str,
                      system_prompt: str) -> AsyncGenerator[str, None]:
    tools = _get_tools()
    full_messages = [{"role": "system", "content": system_prompt}] + messages[-40:]

    while True:
        try:
            import asyncio
            loop   = asyncio.get_event_loop()
            client = _get_llm_client(model)


            call_kwargs: dict = dict(
                model=model, messages=full_messages, stream=True,
            )
            if tools:
                call_kwargs["tools"] = tools
                call_kwargs["tool_choice"] = "auto"

            accumulated_text = ""
            tool_calls_raw: list[dict] = []
            current_tc: dict | None = None

            def _do_stream():
                return client.chat.completions.create(**call_kwargs)

            stream = await loop.run_in_executor(None, _do_stream)

            for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta is None:
                    continue


                if delta.content:
                    accumulated_text += delta.content
                    yield f"data: {json.dumps({'type':'text','delta':delta.content})}\n\n"


                if hasattr(delta, "tool_calls") and delta.tool_calls:
                    for tc_delta in delta.tool_calls:
                        idx = tc_delta.index
                        while len(tool_calls_raw) <= idx:
                            tool_calls_raw.append({"id":"","name":"","arguments":""})
                        if tc_delta.id:
                            tool_calls_raw[idx]["id"] = tc_delta.id
                        if tc_delta.function:
                            if tc_delta.function.name:
                                tool_calls_raw[idx]["name"] = tc_delta.function.name
                            if tc_delta.function.arguments:
                                tool_calls_raw[idx]["arguments"] += tc_delta.function.arguments


                finish = chunk.choices[0].finish_reason if chunk.choices else None
                if finish == "tool_calls" or (finish == "stop" and tool_calls_raw):
                    break


            if not tool_calls_raw:
                break


            assistant_msg: dict = {"role": "assistant", "content": accumulated_text or None}
            assistant_msg["tool_calls"] = [
                {"id": tc["id"], "type": "function",
                 "function": {"name": tc["name"], "arguments": tc["arguments"]}}
                for tc in tool_calls_raw
            ]
            full_messages.append(assistant_msg)

            for tc in tool_calls_raw:
                try:
                    args = json.loads(tc["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                yield f"data: {json.dumps({'type':'tool_call','name':tc['name'],'input':args})}\n\n"

                result = await loop.run_in_executor(None, _execute_tool, tc["name"], args)


                if isinstance(result, dict) and "_navigate" in result:
                    nav = result.pop("_navigate")
                    yield f"data: {json.dumps({'type':'navigate', **nav})}\n\n"

                yield f"data: {json.dumps({'type':'tool_result','name':tc['name'],'result':result})}\n\n"

                full_messages.append({
                    "role":         "tool",
                    "tool_call_id": tc["id"],
                    "content":      json.dumps(result, ensure_ascii=False),
                })

            tool_calls_raw = []

        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'message': str(e)[:300]})}\n\n"
            break

    yield f"data: {json.dumps({'type':'done'})}\n\n"




class NewConvBody(BaseModel):
    cluster_id: Optional[str] = None
    model:      Optional[str] = None


class MessageBody(BaseModel):
    content: str
    context: dict = {}


@router.get("/conversations")
def list_conversations(cluster_id: Optional[str] = None, limit: int = 20):
    index = _load_index()
    if cluster_id is not None:
        index = [e for e in index if e.get("cluster_id") == cluster_id]
    return {"conversations": index[:limit]}


@router.post("/conversations")
def create_conversation(body: NewConvBody):
    prefs = get_all_preferences()
    model = body.model or prefs.get("chat_model", "deepseek-v4-pro")
    conv  = _new_conv(body.cluster_id, model)
    _save_conv(conv)
    return conv


@router.get("/conversations/{conv_id}")
def get_conversation(conv_id: str):
    conv = _load_conv(conv_id)
    if conv is None:
        raise HTTPException(404, f"会话 {conv_id} 不存在")
    return conv


@router.delete("/conversations/{conv_id}")
def delete_conversation(conv_id: str):
    p = _conv_path(conv_id)
    if not p.exists():
        raise HTTPException(404, f"会话 {conv_id} 不存在")
    p.unlink()
    index = [e for e in _load_index() if e["id"] != conv_id]
    _save_index(index)
    return {"ok": True}


@router.delete("/conversations/{conv_id}/messages")
def clear_messages(conv_id: str):
    conv = _load_conv(conv_id)
    if conv is None:
        raise HTTPException(404, f"会话 {conv_id} 不存在")
    conv["messages"] = []
    conv["title"] = ""
    _save_conv(conv)
    return {"ok": True}


@router.post("/conversations/{conv_id}/messages")
async def send_message(conv_id: str, body: MessageBody):
    conv = _load_conv(conv_id)
    if conv is None:
        raise HTTPException(404, f"会话 {conv_id} 不存在")

    prefs      = get_all_preferences()
    cluster_id = body.context.get("cluster_id") or conv.get("cluster_id")
    model      = conv.get("model") or prefs.get("chat_model", "deepseek-v4-pro")


    user_msg = {"role": "user", "content": body.content,
                "ts": datetime.now(timezone.utc).isoformat()}
    conv["messages"].append(user_msg)
    if not conv.get("title") and body.content:
        conv["title"] = body.content[:40]

    system_prompt = _build_system_prompt(cluster_id, body.context, prefs)
    history = [{"role": m["role"], "content": m["content"]}
               for m in conv["messages"]]


    assistant_chunks: list[str] = []
    tool_events: list[dict] = []

    async def _gen() -> AsyncGenerator[str, None]:
        async for event_str in _stream_llm(history, model, system_prompt):

            if event_str.startswith("data: "):
                try:
                    ev = json.loads(event_str[6:])
                    if ev.get("type") == "text":
                        assistant_chunks.append(ev.get("delta", ""))
                    elif ev.get("type") in ("tool_call", "tool_result"):
                        tool_events.append(ev)
                except Exception:
                    pass
            yield event_str


        assistant_content = "".join(assistant_chunks)
        if assistant_content or tool_events:
            conv["messages"].append({
                "role": "assistant",
                "content": assistant_content,
                "tool_events": tool_events,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
        _save_conv(conv)

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
