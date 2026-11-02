# 启动故障注入与界面验证

本记录描述前一版诊断界面；后续统一进度、简洁错误页和系统另存为验证见 [连贯启动界面与运行日志验证](startup-progress-and-runtime-logs-2026-11-02.zh.md)。

日期：2026-11-02。Windows x64，真实 Electron 调试实例。

## 结果

| 场景 | 实际触发方式 | 验证结果 |
| --- | --- | --- |
| Gateway 异常终止 | 临时 Gateway 入口执行 process.abort() | 退出 134 / signal=null，显示 PD_RUNTIME_PROCESS_FAILED，没有误判 OOM |
| Gateway 内存不足 | 仅对测试 Gateway 加 16 MiB 堆限制并持续分配对象 | 真实退出 134，显示 PD_RUNTIME_OUT_OF_MEMORY，保存独立 Node 报告；报告无环境变量 |
| Gateway 缺少模块 | 临时入口 import 不存在的文件 | 退出 1，显示 PD_RESOURCE_NOT_FOUND，并保留原始 ERR_MODULE_NOT_FOUND |
| 配置 YAML 语法错误 | 临时配置写入未闭合数组 | 原接口返回 invalid，Gateway 不启动，界面显示 PD_CONFIG_INVALID、配置位置和日志位置；原错误文件字节保持不变 |
| Web 服务缺少模块 | 临时 Web 入口 import 不存在的文件 | Web 尚未可用时，桌面原生恢复页显示 PD_RESOURCE_NOT_FOUND、原始错误、日志位置及重试/打开日志按钮 |
| 重试恢复 | 去除临时 Gateway 故障后，在真实界面点击重试 | Gateway 变为 ready，项目接口返回 200，主界面恢复 |

所有故障均发生在临时复制的运行时、PILOT_HOME 和 Electron userData 中，不使用真实模型 API，不改动真实配置或密钥。134 的故障注入验证不代表已确定用户原报告的根因。

## 本次测试发现并修复

1. 缺少模块的 Node 错误只出现在 stderr 时，分类器之前只显示进程失败；现在识别明确的 ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND 证据。
2. Web 服务在监听前退出时，桌面恢复页之前丢失捕获的 stderr；现在传递并保存同一份诊断详情。
3. Gateway 长堆栈会把日志路径挤到滚动区域底部；日志路径现在单独显示。
4. 原配置错误页缺少诊断信息；只补充错误码、配置路径、日志路径及桌面日志按钮，未改配置读写或 YAML 格式。

## 自动检查

- 诊断及错误分类：9 项通过，包含真实缺失模块和真实 OOM。
- 启动错误界面、桌面停止与错误接口：25 项通过。
- Web 类型检查、生产构建及 Desktop 编译通过。

## 复现与产物

运行 `node scripts/benchmark-startup.mjs --desktop --fault <场景> --artifacts <目录> --hold-ms 600000`。

场景参数为 `abort`、`oom`、`module-missing`、`config-invalid` 或 `web-module-missing`。这只修改临时复制的文件。向产物目录写入名为 `stop` 的文件可提前结束，脚本会清理测试进程与临时运行时，并归档日志。

截图和本机日志位于未纳入 Git 的 `artifacts/startup-errors-2026-11-02/`，每个场景都有 `screen.png`、`result.json`、`logs/runtime.log`。OOM 的独立报告在对应 `logs/diagnostics/`；重试后的截图为 `abort/recovered.png`。汇总为 `summary.json`。
