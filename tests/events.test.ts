import { expect, test } from "bun:test";
import { rowsFromEvent } from "../extensions/events.ts";

test("renders provider reasoning summaries without exposing encrypted content", () => {
  const rows = rowsFromEvent({
    Kind: "model_response",
    Data: { Response: {
      Output: [
        { Type: "reasoning", Data: { Summary: ["Conferi as opções."], Raw: { encrypted_content: "secret" } } },
        { Type: "message", Data: { Role: "assistant", Phase: "final_answer", Text: "Feito." } },
      ],
      Usage: { ReasoningTokens: 25 },
    } },
  });
  expect(rows).toEqual([
    { kind: "reasoning", text: "Conferi as opções." },
    { kind: "assistant", text: "Feito." },
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
  expect(rows).toEqual([{ kind: "reasoning", text: "Raciocínio usado (8 tokens); o provedor não enviou resumo legível." }]);
});
