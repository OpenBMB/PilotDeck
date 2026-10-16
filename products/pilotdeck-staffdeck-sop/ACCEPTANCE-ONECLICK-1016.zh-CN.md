# 无 Docker 一键启动验收，2026-10-16

新增 `pnpm start:sop`：同一配置构建 Web/Gateway，统一启动器先启动独立
Python Runtime，健康检查后启动 Web，再由配置就绪事件启动 Gateway。
`localRuntime.enabled` 显式开启；原有远程/独立 Runtime 配置不变。

## 实际启动

使用隔离 `PILOT_HOME`、SQLite、配置和空模型地址，仅检查服务启动，不声称本轮
重跑真实模型业务。命令为：

```bash
PILOT_HOME=/tmp/pd-oneclick-KWO2Aa \
PILOTDECK_CONFIG_PATH=/tmp/pd-oneclick-KWO2Aa/pilotdeck.yaml \
PILOTDECK_DISABLE_LOCAL_AUTH=0 \
SERVER_PORT=27595 PILOTDECK_GATEWAY_PORT=27593 \
PILOTDECK_GATEWAY_URL=ws://127.0.0.1:27593/ws pnpm start:sop
```

- Gateway TypeScript 和 Web 生产构建通过。
- 首次自动创建 Python 3.12 venv、安装 PD 内独立包，无 StaffDeck checkout 运行依赖。
- Runtime `127.0.0.1:27591/healthz` 返回 `status: ok`、`sop.lifecycle/v3`、Runtime 状态所有权。
- Web `127.0.0.1:27595/sop` 返回 HTTP 200。
- Gateway `127.0.0.1:27593` 就绪，Web bridge 连接成功。
- 向一键启动进程发送 SIGINT，Runtime 完成 shutdown，PD 进程退出，三个端口释放。
- 未停止或切换现有 27491/27493/27495 LaunchAgent 部署，未迁移其数据库。

## 聚焦验证

- 真实 Python 进程测试：全新环境安装、知识关闭/版本开启、创建草稿、重启读取、
  发布 token 复用、退出释放端口，共 2 项通过。
- 统一启动器 15 项通过，包含 SOP 就绪前不启动 Web、token 服务端传递、失败阻止启动、
  Runtime 异常退出停止 PD、退出清理，以及原 Web/Gateway 重启行为。
- YAML 配置 26 项通过，包含原 StaffDeck 配置和本地 Runtime 配置及远程地址拒绝。
- TypeScript noEmit 和 diff 检查通过。

需要 Node 22.x、pnpm、Python 3.11+（含 venv/pip）。首次安装 Python 依赖需要网络；
后续启动复用环境和 SQLite。Docker 未参与部署。模型凭据和 Skill/工具配置仍由 PD 提供。
本轮为启动部署变更，不替代八项功能的真实模型验收报告。
