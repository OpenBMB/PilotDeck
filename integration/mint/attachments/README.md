# Attachments 包侧整改

正式发布：liyishan1/pilotdeck-attachments-consumer@0.1.1（MintHub seq1252）。
源码仓库分支 codex/attachments-package-owned，源码提交5d7a667，发布版本提交e4d2177。
Mint整理分支 codex/attachments-owned-split，末端d4728cd8，代码与ae777696一致。
原分支均保留。Core没有附件材料化或专属加载选项；公共iface未修改。

原 e699b87f → f1cab578（日志）、a1c584f3（恢复）、bd1bfa58（输入）。
原74f55cac → 5efd29d7（已去掉附件材料化，保留通用投影）。
其余映射按功能：

- `1d20b130` fix(mint-host): support UTF-8 codecs and configured hook deadlines
- `f1cab578` fix(acp): persist streams and order mapped tool events
- `a1c584f3` fix(acp): bind recovered sessions to live Kernel execution
- `bd1bfa58` feat(acp): transport structured history and validated attachment references
- `5efd29d7` feat(core): enforce required packages and compose context projections
- `5a24b3fe` feat(host): stream installed model consumer events
- `a5fbc403` feat(kernel): bind installed providers to model invocation ownership
- `95e54392` feat(loop): allow composed services and propagate cancellation and failure
- `0abe5ee4` feat(core): adapt installed services to the external Rust loop
- `986aca40` feat(integration): assemble installed packages with external Kernel and Rust loop
- `d4728cd8` test(integration): add installed package assembly probe

验证：包6项、ACP89项、文件服务17项通过。新安装实例attachments-registry-project，正式下载0.1.1，无附件本地覆盖。
真实模型读取amber-618/青岛；直接ACP缺失附件失败，模型请求计数不变。
日志：运行目录attachments-unified/data/supervisor/installed-rust-loop.log及attachments-registry-e2e.log。

注意：fs.stat没有size，包按范围读取计算长度；使用前后mtime/path/kind检测变化，无法检测元数据完全相同的修改。图片验证仍不可用。

网页验收：会话web:s_f6ba3146-960c-44b9-8ccf-d58be387aabd，上传后回答amber-618，追问回答青島；请求证据含原文青岛和🙂。截图位于运行目录attachments-browser-proof.png。

构建验证针对ae777696（与d4728cd8代码一致）；收尾时工作区出现另一组上下文hooks修改，未纳入本次提交。
