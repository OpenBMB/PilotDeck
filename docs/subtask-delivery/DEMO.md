# Demo — minimal steps

[Watch or download the 1:57 demo](https://github.com/changer-changer/PilotDeck/releases/download/delivery-demo-20260913/pilotdeck-delivery-demo.mp4) · [Video and provenance](https://github.com/changer-changer/PilotDeck/releases/tag/delivery-demo-20260913). The recording shows the real interface and retained model results, shortened at 1.5× speed, with deliberately seeded initial faults.

Requires Node 22, pnpm and a working OpenAI-compatible endpoint with tool support. Defaults: child `glm-5.3-flash`, main/reviewer `glm-5.3`. Set `DELIVERY_DEMO_MAIN` / `DELIVERY_DEMO_CHILD` for other available models.

```sh
pnpm install --frozen-lockfile
pnpm build
export DELIVERY_DEMO_ENDPOINT='https://your-provider/v1'
read -rs DELIVERY_DEMO_API_KEY
export DELIVERY_DEMO_API_KEY
node --import tsx scripts/subtask-delivery-demo.ts live
```

1. Copy the printed `runRoot`. Wait for all `validation` values to be `true`.
2. Start the isolated UI:

```sh
DELIVERY_DEMO_RUN='<runRoot>' node --import tsx scripts/subtask-delivery-demo.ts ui
```

3. Open the printed **Vite client** address. Open the project's **子任务交付验收演示** conversation.
4. Expand **Processed → Delivery review → Show all attempts**. Show the missing file, semantic rejection, local repairs, actual reviewer and token counts.
5. Open **runbook.md** to inspect the actual repaired content. Show that the text-only task has a receipt and **skipped** checks.
6. Open **Settings → Agents → Delivery**. Edit the prompt → **Save**; change the reviewer or use the main model; demonstrate Off/Auto; **Restore default → Save**.

Existing OpenCode Zhipu users can explicitly pass `--opencode-auth` to both commands instead of exporting a key. Keys are read locally; the generated config contains an environment reference, not a literal key. The provider config uses `extraBody.metadata: null` for Zhipu compatibility.

This demo intentionally seeds first-delivery faults through its child-only demo prompt. The parent, child, repairs and Judge use real models. It is a demonstration of the recovery path, not a natural success-rate benchmark. `validation.json` checks the files as well as the statuses; a false Judge acceptance makes validation fail. New demo runs use a new isolated workspace. After restoring the prompt, create a fresh run to repeat the seeded demonstration.

## 现场口径

“子代理完成对话，不等于交付可信。这里先检查它声明的文件和位置，再由主代理按需请求模型评审。错误交回原子代理局部修复，每次记录单独保存。提示词只是可编辑示例，没填的字段跳过；模型没看清的结果不会标成通过。”

“这是预置故障演示，所有修复和裁判调用都是真实的。实验中原版的小任务成功率已经很高，我们不宣称普遍领先；当前证据支持的是具体错误的拦截、局部修复，以及约束评审开销。”
