export type Row = { kind: "user" | "assistant" | "reasoning" | "tool" | "error" | "info"; text: string };
export type Event = { Kind?: string; Data?: any };

export function rowsFromEvent(event: Event): Row[] {
  const rows: Row[] = [];
  const add = (kind: Row["kind"], text: string) => {
    if (text.trim()) rows.push({ kind, text });
  };

  if (event.Kind === "model_response") {
    const response = event.Data?.Response;
    let showedReasoning = false;
    for (const item of response?.Output ?? []) {
      if (item.Type === "message" && item.Data?.Role === "assistant") {
        add(item.Data.Phase === "commentary" ? "reasoning" : "assistant", item.Data.Text ?? "");
      } else if (item.Type === "reasoning") {
        const summary = (item.Data?.Summary ?? [])
          .filter((part: unknown) => typeof part === "string" && part.trim())
          .join("\n");
        if (summary) {
          add("reasoning", summary);
          showedReasoning = true;
        }
      } else if (item.Type === "tool_call") {
        add("tool", `→ ${item.Data?.Name ?? "tool"} ${item.Data?.Arguments ?? ""}`);
      } else if (item.Type === "tool_result") {
        const output = (item.Data?.Output ?? [])
          .filter((part: any) => part.Kind === "text")
          .map((part: any) => part.Value)
          .join("\n");
        add("tool", output);
      }
    }
    const reasoningTokens = response?.Usage?.ReasoningTokens ?? 0;
    if (!showedReasoning && reasoningTokens > 0) {
      add("reasoning", `Raciocínio usado (${reasoningTokens} tokens); o provedor não enviou resumo legível.`);
    }
    if (response?.Failure?.Message) add("error", response.Failure.Message);
  } else if (event.Kind === "tool_call_status" && event.Data?.Status?.Error) {
    add("error", event.Data.Status.Error);
  }
  return rows;
}
