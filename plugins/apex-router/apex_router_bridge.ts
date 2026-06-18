/**
 * APEX Φ Router Bridge — 多LLM辩证进化路由器
 * 公式: LDR(K) → GapDetect → ConfigSelfFix → HotReload → Debate → Synthesize → AGI
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const APEX_BRIDGE_URL = "http://127.0.0.1:18765/score";

export class ApexRouterBridge {
  get id() {
    return "apex-phi-router";
  }

  private shouldDebate(messages: any[]): boolean {
    if (!messages || messages.length === 0) return false;
    const lastMsg = messages[messages.length - 1]?.content || "";
    const lower = lastMsg.toLowerCase();
    return (
      lower.includes("辩论") ||
      lower.includes("debate") ||
      lower.includes("进化") ||
      lower.includes("agi") ||
      lower.includes("self-improv") ||
      lower.includes("evaluate")
    );
  }

  private async runDebate(messages: any[]): Promise<any> {
    console.log("[apex-router] 执行多LLM辩论循环...");
    const debateEngine = join(process.cwd(), "skills/agi-skill/scripts/debate/multi_llm_debate_engine.py");
    if (!existsSync(debateEngine)) {
      return { success: false, error: "Debate engine not found" };
    }
    return new Promise((resolve) => {
      const python = spawn("python3", [debateEngine], {
        env: { ...process.env }
      });
      let stdout = "";
      let stderr = "";
      python.stdout.on("data", (data) => {
        stdout += data.toString();
        console.log(`[debate] ${data.toString().trim()}`);
      });
      python.stderr.on("data", (data) => { stderr += data.toString(); });
      python.on("close", (code) => {
        resolve({ success: code === 0, stdout, stderr, code });
      });
    });
  }

  async decide(input: {
    sessionId: string;
    isMainAgent: boolean;
    request?: { messages?: any[] };
  }): Promise<any> {
    console.log("[apex-router] decide called, sessionId:", input.sessionId);
    const messages = Array.isArray(input.request?.messages) ? input.request.messages : [];
    if (this.shouldDebate(messages)) {
      console.log("[apex-router] 触发多LLM辩论循环");
      const debateResult = await this.runDebate(messages);
      return {
        provider: "nvidia",
        model: "nemotron-3-nano-omni-30b-a3b-reasoning",
        scenarioType: "custom",
        resolvedFrom: "custom",
        tokenSaverTier: "reasoning",
        orchestrating: true,
        mutations: {
          orchestrationPromptInjected: { tier: "reasoning", chars: 2048 }
        },
        requestPatch: {
          messages: [
            {
              role: "system",
              content: `你是PilotDeck辩论路由器。使用多LLM辩证法：
1. LDR: 用NVIDIA Nemotron 30B进行深度理解
2. GapDetect: 找出当前状态与AGI目标的差距
3. Debate: 邀请NVIDIA和Groq从正反双方辩论
4. Synthesize: 综合辩论结果，收敛最优解
5. AGI: 进化系统能力`
            },
            ...messages
          ]
        }
      };
    }
    if (input.isMainAgent && messages.length > 0) {
      return {
        provider: "nvidia",
        model: "nemotron-3-nano-omni-30b-a3b-reasoning",
        scenarioType: "custom",
        resolvedFrom: "custom",
        tokenSaverTier: "complex",
        orchestrating: true
      };
    }
    return undefined;
  }
}
