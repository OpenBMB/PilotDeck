# Parallel C Deployment Preparation

结论：本报告保留的是 2026-09-20 之前的部署准备记录，不是当前 G4/G5
台账。后续同日完成的 native-five runtime 和连续真实模型证据已经归档到
`conformance/artifacts/g4-native-five-runtime-20260920/` 和
`conformance/artifacts/g5-native-five-continuous-20260920/`；当前 G4/G5
状态以 `ACCEPTANCE_REQUIREMENTS.md` 为准。

## 范围

- 工作目录：`/Users/a1/Desktop/claw/openbmb/PilotDeck-delivery-deploy`
- 分支：`codex/delivery-deploy-20260920`
- 只改 `products/pilotdeck-staffdeck-sop` 的 exporter/profile/部署脚本/真实 runner，以及 exporter 聚焦测试；未改 `src/composition`、Context/协议核心或公共验收文档。
- 新 profile：`profiles/native-five-staffdeck.yaml`。其中 `agentLoop`、`skills`、`tools`、`context`、`modelProvider` 保持 PilotDeck native；`staffdeck.knowledge` 和 `staffdeck.portable-sop` 明确作为跨进程外部依赖。

## 已完成

1. `export-composition.mjs` 保留原有 portable 默认；delivery worktree 通过 `--staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-delivery-deploy` 或 `STAFFDECK_SOP_ROOT` 显式传入。生成的 `.env.example` 声明运行时真实模型凭据和 base URL 变量，README 明确凭据不进入导出包。`native-five-staffdeck.yaml` 的 provider URL 使用 `${PILOTDECK_REAL_MODEL_BASE_URL}`，export 时由环境变量物化到隔离配置。
2. `run-local-e2e.sh` 和 `run-local-web-smoke.sh` 保留 portable 默认；delivery worktree 通过 `STAFFDECK_SOP_RUNTIME_CONTEXT=/Users/a1/Desktop/claw/openbmb/StaffDeck-delivery-deploy` 显式传入。
3. `run-real-model-smoke.mjs` 增加可选真实 Knowledge + native Skill 路径：运行时从 `/Users/a1/.pilotdeck` 读取 provider 配置和真实 URL，创建临时 Skill，断言 `read_skill`、`read_file`、`knowledge_query`、SOP handoff/resume/completed；追加三轮真实历史后执行 `/compact`，要求 Gateway `agent_status/event=compact_completed/detail.status=compacted`、transcript `compaction_completed.status=compacted` 与 `control_boundary.compactMetadata.summaryGenerated=true` 同时存在。凭据只通过环境变量运行时注入。
4. Gateway `/compact` 的受控预检脚本已持久化为 `scripts/gateway-compact-preflight.mjs`；它只证明真实 Gateway 手动压缩事件与同 turn JSONL 记录关联，不替代最终 G4/G5。

## 验证

- `env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH npm run build`：退出码 `0`。使用原树 `node_modules` 的临时 symlink，产物写入本隔离树 `dist`；symlink 已移除。环境默认 `NODE_OPTIONS` 指向缺失的 `/Users/a1/.openclaw/proxy-preload.mjs`，所以验证命令显式清空它。
- `env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH node --test --test-force-exit dist/tests/composition/export-composition.spec.js`：退出码 `0`，`7/7` PASS。
- `node --check products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs`：退出码 `0`。
- `node --check products/pilotdeck-staffdeck-sop/scripts/run-real-model-smoke.mjs`：退出码 `0`。
- native-five 导出命令（显式 `--staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-delivery-deploy`）：退出码 `0`；生成配置保留五个 native owner，并列出 Knowledge/SOP 两个外部依赖。
- `docker compose --env-file <runtime env> -f <export>/compose.yaml config`：退出码 `0`。只做 Compose 拓扑解析，没有启动外部服务或声明部署通过。
- `env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH node --test --test-force-exit dist/tests/agent/session/manual-compaction-controller.spec.js`：退出码 `0`，`6/6` PASS；这是 owner-level durable compact success/failure/recovery/skipped 证据，不作为 Gateway runner 执行证据。
- 临时真实 Gateway 预检 `/tmp/pilotdeck-gateway-compact-preflight.mjs`：使用本地确定性 SSE summary provider、真实 `createLocalGateway`、真实 session JSONL，执行三轮历史后 `gateway.submitTurn("/compact")`；退出码 `0`。返回 `agent_status/event=manual_compaction/detail.outcome=compacted`，同一 `turnId` 的 JSONL 含 `turn_started -> compaction_started -> control_boundary -> compaction_completed -> turn_result`，且 `compactMetadata.summaryGenerated=true`；旧 turn 不匹配。首次过大的 fixture 只触发自动/反应式 skipped 并 context overflow，已缩小为手动路径可执行 fixture，保留该失败原因。
- `git diff --check`：退出码 `0`。

## 历史 G4/G5 预检状态

- G4：历史记录为 `PARTIAL / NOT READY`，因为当时只完成导出拓扑和配置预检。该状态已被 durable native-five G4 artifact superseded。
- G5：历史记录为 `PARTIAL / NOT READY`，因为当时未启动真实 StaffDeck 服务或 provider。该状态已被 durable continuous G5 artifact superseded；G5 未在本轮台账修订中重跑。

以下命令是当时的可执行预检流程，保留作历史参考，不等同当前 G4/G5：

```bash
SD=/Users/a1/Desktop/claw/openbmb/StaffDeck-delivery-deploy
ARTIFACT_DIR=$(mktemp -d /tmp/pilotdeck-g5-artifacts.XXXXXX)
STAFFDECK_PYTHON="${STAFFDECK_PYTHON:-$ARTIFACT_DIR/staffdeck-venv/bin/python}"
if [ ! -x "$STAFFDECK_PYTHON" ]; then
  uv venv "$ARTIFACT_DIR/staffdeck-venv" --python 3.12
  uv pip install --python "$STAFFDECK_PYTHON" -e "$SD/backend"
fi
```

可先运行现有 owner lifecycle 快速预检（它会创建自己的临时 SQLite 并验证导入/job/query/citation/restart；不把该临时 base 当作 runner 输入）：

```bash
PYTHONPATH="$SD/backend:$SD/backend/src:$SD/portable_sop/src" \
  python3 products/pilotdeck-staffdeck-sop/conformance/run_staffdeck_knowledge_lifecycle.py \
  --staffdeck-root "$SD" --python "$STAFFDECK_PYTHON" \
  --port 18296 --artifact-dir "$ARTIFACT_DIR/lifecycle"
```

启动两个真实服务（本地端口方式，runner 使用 `127.0.0.1`）：

```bash
PYTHONPATH="$SD/backend:$SD/backend/src:$SD/portable_sop/src" \
  "$STAFFDECK_PYTHON" -m uvicorn staffdeck_sop_runtime.api:app \
  --host 127.0.0.1 --port 8091 >"$ARTIFACT_DIR/sop.log" 2>&1 &
SOP_PID=$!
PYTHONPATH="$SD/backend:$SD/backend/src:$SD/portable_sop/src" \
  DATABASE_URL="sqlite:///$ARTIFACT_DIR/knowledge.sqlite" \
  DEMO_SEED_ENABLED=false STAFFDECK_KNOWLEDGE_SEED=true \
  STAFFDECK_KNOWLEDGE_USER_ID=admin STAFFDECK_KNOWLEDGE_TENANT_ID=tenant_demo \
  "$STAFFDECK_PYTHON" -m uvicorn app.module_knowledge_app:app \
  --host 127.0.0.1 --port 8090 >"$ARTIFACT_DIR/knowledge.log" 2>&1 &
KB_PID=$!
trap 'kill "$SOP_PID" "$KB_PID" 2>/dev/null || true' EXIT
curl --fail --retry 60 --retry-delay 1 --retry-max-time 60 http://127.0.0.1:8091/healthz >/dev/null
curl --fail --retry 60 --retry-delay 1 --retry-max-time 60 http://127.0.0.1:8090/api/health >/dev/null
```

Create a content-bearing base in that running Knowledge process and persist its ID for the runner:

```bash
export ARTIFACT_DIR
python3 - <<'PY'
import base64, json, os, time, urllib.request
endpoint = "http://127.0.0.1:8090/v2/module/call"
def call(operation, value):
    now = time.time_ns()
    body = {"kind":"request", "method":"module_call", "messageId":f"message-{now}",
            "runId":"g5-preflight", "operationId":f"operation-{now}",
            "requestId":f"request-{now}", "module":"knowledge",
            "payload":{"operation":operation, "input":value}}
    request = urllib.request.Request(endpoint, data=json.dumps(body).encode(),
                                     headers={"Content-Type":"application/json"})
    response = json.load(urllib.request.urlopen(request, timeout=20))
    if response.get("ok") is not True:
        raise RuntimeError(response)
    return response["payload"]["result"]
base = call("create_base", {"tenantId":"tenant_demo", "actorUserId":"admin",
                             "name":"G5 approval preflight", "description":"temporary"})
base_id = base["id"]
job = call("import_document", {"tenantId":"tenant_demo", "actorUserId":"admin",
    "knowledgeBaseId":base_id, "filename":"approval-policy.md", "title":"Approval policy",
    "contentBase64":base64.b64encode(b"# Approval policy\\n\\nOwner approval is required before release.\\n").decode()})
job_id = job["id"]
for _ in range(150):
    state = call("get_job", {"tenantId":"tenant_demo", "actorUserId":"admin", "jobId":job_id})
    if state.get("status") in {"succeeded", "completed", "success"}: break
    if state.get("status") in {"failed", "cancelled"}: raise RuntimeError(state)
    time.sleep(0.2)
else:
    raise TimeoutError(state)
os.makedirs(os.environ["ARTIFACT_DIR"], exist_ok=True)
open(os.path.join(os.environ["ARTIFACT_DIR"], "base-id"), "w").write(base_id + "\n")
print(base_id)
PY
BASE_ID=$(cat "$ARTIFACT_DIR/base-id")
```

Export the profile with the authorized provider route from `/Users/a1/.pilotdeck` (the key is never copied):

```bash
BASE_URL=$(env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  node --input-type=module -e 'import { readFileSync } from "node:fs"; import YAML from "yaml"; const c=YAML.parse(readFileSync("/Users/a1/.pilotdeck/pilotdeck.yaml", "utf8")); const u=c?.model?.providers?.provider1?.url; if (typeof u !== "string" || !u) process.exit(2); process.stdout.write(u);')
PILOTDECK_REAL_MODEL_BASE_URL="$BASE_URL" \
  node products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs \
  --profile products/pilotdeck-staffdeck-sop/profiles/native-five-staffdeck.yaml \
  --staffdeck-root "$SD" --out "$ARTIFACT_DIR/export"
```

Then run the controlled real runner with the real service ports and the `base-id` created in the running Knowledge process:

```bash
PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
REAL_MODEL_SOURCE_PILOT_HOME=/Users/a1/.pilotdeck \
REAL_MODEL_SMOKE_MODEL=provider1/qwen3.6-flash-distill \
STAFFDECK_SOP_SMOKE_ENDPOINT=http://127.0.0.1:8091 \
REAL_MODEL_KNOWLEDGE_ENDPOINT=http://127.0.0.1:8090 \
REAL_MODEL_KNOWLEDGE_BASE_ID="$BASE_ID" \
node products/pilotdeck-staffdeck-sop/scripts/run-real-model-smoke.mjs
```

凭据不可打印、复制或提交。Docker 缓存中有 `node:22-bookworm-slim`，但本轮没有重复尝试此前无变化的 `node:22-bookworm` Hub 构建；当前 profile 使用外部 StaffDeck 服务，因此该镜像阻塞不影响导出预检。

交付提交号、未提交状态和请求审阅/集成见协调消息；本报告不把提交等同于最终验收。
