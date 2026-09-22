import { expect, test } from "bun:test";
import { rowsFromEvent } from "../extensions/events.ts";

test("renders provider reasoning summaries without exposing encrypted content", () => {
  const rows = rowsFromEvent({
    Kind: "model_response",
    Data: { Response: {
      Output: [
        { Type: "reasoning", Data: { Summary: ["I checked the options."], Raw: { encrypted_content: "secret" } } },
        { Type: "message", Data: { Role: "assistant", Phase: "final_answer", Text: "Done." } },
      ],
      Usage: { ReasoningTokens: 25 },
    } },
  });
  expect(rows).toEqual([
    { kind: "reasoning", text: "I checked the options." },
    { kind: "assistant", text: "Done." },
  ]);
  expect(JSON.stringify(rows)).not.toContain("secret");
});

test("reports used reasoning when only encrypted content is returned", () => {
  const rows = rowsFromEvent({
    Kind: "model_response",
    Data: { Response: {
      Output: [{ Type: "reasoning", Data: { Summary: [], Raw: { encrypted_content: "secret" } } }],
      Usage: { ReasoningTokens: 8 },
    } },
  });
  expect(rows).toEqual([{ kind: "reasoning", text: "Reasoning used (8 tokens); the provider did not return a readable summary." }]);
});
