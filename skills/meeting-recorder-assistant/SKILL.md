---
name: meeting-recorder-assistant
description: Process an uploaded meeting or field recording through the configured local Trans-Speech service. Use when the current chat contains a .wav, .mp3, .m4a, or .flac attachment and the user wants transcription, polishing, meeting minutes, or action items.
---

# 录音整理 Skill

处理政研室授权范围内、已经上传到当前工作区的录音。调用本机或受控局域网中的 Trans-Speech，生成可追溯、可编辑的逐字稿、逐字整理稿和会议纪要。

## 触发规则

1. 当前聊天附件中出现 `.wav`、`.mp3`、`.m4a` 或 `.flac` 时，除非用户明确表示“不转写”或“只保存文件”，应使用 `trans_speech` Tool。
2. 一个音频文件对应一个独立任务，不能合并音频、拼接逐字稿或把多个录音汇总成一份会议纪要。
3. 多个文件时逐个调用 Tool。每个文件都应使用聊天附件中给出的原始路径。
4. 如果 Tool 返回重复任务，先询问用户查看已有任务还是仍然新建；只有用户明确选择新建时，才用 `force_duplicate: true` 再次调用。
5. 用户明确要求待办事项时，传 `include_actions: true`；系统会同时生成会议纪要，并将待办事项写在纪要末尾。否则不要生成待办事项。

## 调用方式

对每个已上传音频调用：

```json
{
  "action": "start",
  "audio_path": "聊天附件提供的精确路径"
}
```

Tool 默认生成：

- `逐字稿.md`：标注“机器转写初稿”，保留说话人和时间信息；
- `逐字整理稿.md`：机器生成初稿，需人工审核；
- `会议纪要.md`：机器生成初稿，不能直接作为正式结论或发文材料。

不要把完整逐字稿复制到聊天。只汇报任务状态、简短摘要和结果文件路径，并在需要时通过 `send_attachment` 提供文件入口。

## 重试与取消

1. Tool 返回“部分完成”时，保留已经生成的文件。用户要求重试时调用：

```json
{
  "action": "retry",
  "task_id": "任务编号"
}
```

2. 用户要求停止或取消时调用：

```json
{
  "action": "cancel",
  "task_id": "任务编号"
}
```

取消是软取消：不再等待当前调用、不再启动后续步骤，也不写入取消后返回的结果；已经发给 Trans-Speech 的服务端计算可能仍会继续。

## 数据边界

- 仅处理当前工作区中用户授权上传的音频。
- 不把音频、逐字稿或生成结果自动发送到公网、知识库、长期记忆或共享资料库。
- 任务结果保存在当前工作区 `录音整理任务/<任务ID>/`，其中包含原始音频、任务信息、处理记录和 Markdown 成果。
