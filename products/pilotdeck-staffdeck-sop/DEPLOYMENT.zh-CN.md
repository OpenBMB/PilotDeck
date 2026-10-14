# 七槽版一键部署

本文说明 PilotDeck + StaffDeck 的七槽部署方式。当前交付配置包含：

| Slot | 实现 | 进程 |
| --- | --- | --- |
| agentLoop | PilotDeck | pilotdeck |
| skills | PilotDeck | pilotdeck |
| tools | PilotDeck | pilotdeck |
| context | PilotDeck | pilotdeck |
| modelProvider | PilotDeck + 外部模型 API | pilotdeck |
| sop | StaffDeck Portable SOP | sop-runtime:8091 |
| knowledge | StaffDeck Knowledge | knowledge-runtime:8090 |

sop-runtime 仅安装独立 `portable_sop` 包，使用 `sop.lifecycle/v3` session API 和自己的 SQLite 数据卷。knowledge-runtime 仍使用 StaffDeck backend；Knowledge 只在 Compose 内网监听，不暴露宿主机端口。

## 1. 环境要求

- Linux、macOS 或 Windows
- Docker Engine 24+ 和 Docker Compose v2+
- Node.js 22+
- 可访问的 OpenAI-compatible 模型 API
- 首次构建时可访问 Python 包源

StaffDeck 当前部署不需要 Redis、PostgreSQL、MySQL、MinIO 等额外服务。默认关闭 Harness v3，因此不需要额外的 Node Harness 服务。

## 2. 准备 StaffDeck 源码

导出器默认从 PilotDeck 同级目录查找已验证的 StaffDeck checkout：

~~~text
/opt/openbmb/PilotDeck
/opt/openbmb/StaffDeck-portable-sop
~~~

也可以显式指定路径：

~~~bash
export STAFFDECK_SOP_ROOT=/opt/openbmb/StaffDeck-portable-sop
~~~

本次版本配对使用两个仓库的 `standalone_alpha1_decouple_sop_1013` 分支。完整验收状态和部署限制见 `ACCEPTANCE-1014.zh-CN.md`。定义必须先发布到 Runtime，执行过程中使用已保存快照。

## 3. 配置模型 API

导出前设置模型服务的 OpenAI-compatible base URL：

~~~bash
export PILOTDECK_REAL_MODEL_BASE_URL=https://your-model.example.com/v1
~~~

导出时只写入 URL，不会复制模型 API Key。Key 在部署目录的 .env 中填写。

## 4. 导出七槽部署目录

在 PilotDeck 根目录执行：

~~~bash
node products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs \
  --profile products/pilotdeck-staffdeck-sop/profiles/native-five-staffdeck.yaml \
  --out /opt/pilotdeck-seven
~~~

## 5. 配置 .env

~~~bash
cd /opt/pilotdeck-seven
cp .env.example .env
~~~

编辑 .env：

~~~env
PILOTDECK_API_KEY=replace-with-pilotdeck-key
PILOTDECK_REAL_MODEL_API_KEY=replace-with-model-key
PILOTDECK_REAL_MODEL_BASE_URL=https://your-model.example.com/v1
STAFFDECK_APP_SECRET=replace-with-random-secret
PILOTDECK_PORT=3001
~~~

中国大陆环境默认使用华为云 Docker Hub 镜像：

~~~env
STAFFDECK_PYTHON_BASE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/python:3.11-slim
~~~

也可以改成阿里云或企业私有仓库中的同版本镜像。

## 6. 启动和验证

~~~bash
docker compose --env-file .env -f compose.yaml config
docker compose --env-file .env -f compose.yaml up -d --build
docker compose --env-file .env -f compose.yaml ps
~~~

预期三个服务均为 running，两个 StaffDeck 服务为 healthy。PilotDeck 会等待两个健康检查通过后再启动对外服务。

验证 PilotDeck 已加载七槽运行时：

~~~bash
set -a; . ./.env; set +a
curl -H "Authorization: Bearer $PILOTDECK_API_KEY" \
  http://127.0.0.1:${PILOTDECK_PORT:-3001}/api/modules/runtime
~~~

Knowledge manifest 应包含 staffdeck.knowledge/v1。SOP 健康检查地址为 http://sop-runtime:8091/healthz，只允许 Compose 内部访问。

## 7. 数据和升级

Knowledge 数据保存在 staffdeck-knowledge-data volume 中。停止和重新创建容器不会删除数据。不要使用 down -v，否则会删除 Knowledge SQLite 数据。

## 8. 常见问题

Docker Hub 连接失败时，确认 .env 设置了 STAFFDECK_PYTHON_BASE_IMAGE。华为云镜像已验证可拉取；阿里云镜像需使用实际存在且有权限的 Python 3.11 slim 仓库路径。

构建阶段 pip 下载超时属于 Python 依赖源网络问题。为 Docker build 环境配置企业 PyPI、阿里云 PyPI 镜像或代理后重新构建。

Knowledge 容器默认设置 HARNESS_V3_ENABLED=0 与 HARNESS_ADMIN_API_ENABLED=0，不依赖 Harness Node 引擎。

## 9. 停止和日志

~~~bash
docker compose --env-file .env -f compose.yaml logs -f pilotdeck
docker compose --env-file .env -f compose.yaml logs -f knowledge-runtime
docker compose --env-file .env -f compose.yaml stop
~~~
