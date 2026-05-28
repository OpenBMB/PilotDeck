import type { CanonicalMessage } from "../../model/index.js";
import type { AgentInput } from "../protocol/input.js";

export type TurnInputProcessorResult = {
  messages: CanonicalMessage[];
  shouldCallModel: boolean;
};

export class TurnInputProcessor {
  accept(input: AgentInput): TurnInputProcessorResult {
    if (input.type === "text") {
      return {
        shouldCallModel: true,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: input.text }],
          },
        ],
      };
    }

    return {
      shouldCallModel: true,
      messages: [
        {
          role: "user",
          content: input.content,
        },
      ],
    };
  }
}
