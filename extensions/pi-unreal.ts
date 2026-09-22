import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { rowsFromEvent, type Row, type Event } from "./events.ts";

const stateRoot = process.env.PI_UNREAL_STATE_DIR || join(homedir(), ".local", "state", "pi-unreal");
const localRunner = join(homedir(), ".local", "bin", "unreal-agent-runner");
const runner = process.env.PI_UNREAL_RUNNER || (existsSync(localRunner) ? localRunner : "unreal-agent-runner");
const model = process.env.PI_UNREAL_MODEL || "gpt-6-sol";

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let active: ChildProcessWithoutNullStreams | undefined;
  let sessionId = "";
  let rowsFile = "";
  let stateFile = "";
  let generation = 0;
  const queue: string[] = [];

  function show(kind: Row["kind"], text: string) {
    if (!text.trim()) return;
    const row = { kind, text };
    pi.appendEntry<Row>("pi-unreal-row", row);
    appendFileSync(rowsFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  function reset(ctx: ExtensionContext) {
    generation++;
    active?.kill("SIGINT");
    active = undefined;
    queue.length = 0;
    const project = createHash("sha256").update(ctx.cwd).digest("hex");
    const directory = join(stateRoot, project);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    rowsFile = join(directory, "rows.jsonl");
    stateFile = join(directory, "state.json");
    if (existsSync(stateFile)) {
      sessionId = JSON.parse(readFileSync(stateFile, "utf8")).sessionId;
    } else {
      sessionId = randomUUID();
      writeFileSync(stateFile, JSON.stringify({ sessionId }), { mode: 0o600 });
    }
    const hasRows = ctx.sessionManager.getEntries().some((entry: any) => entry.type === "custom" && entry.customType === "pi-unreal-row");
    if (!hasRows && existsSync(rowsFile)) {
      for (const line of readFileSync(rowsFile, "utf8").trim().split("\n").slice(-300)) {
        if (!line) continue;
        try { pi.appendEntry<Row>("pi-unreal-row", JSON.parse(line)); }
        catch { /* Ignore one damaged display row; runner history stays intact. */ }
      }
    }
    ctx.ui.setStatus("pi-unreal", "Unreal Agent");
  }

  function activate(ctx: ExtensionContext) {
    if (enabled) return;
    reset(ctx);
    enabled = true;
    ctx.ui.setFooter((_tui, theme) => new Text(theme.fg("accent", `Unreal Agent · ${model} · ${ctx.cwd}`), 0, 0));
  }

  function renderEvent(event: Event) {
    for (const row of rowsFromEvent(event)) show(row.kind, row.text);
  }

  function startNext(ctx: ExtensionContext) {
    if (active || queue.length === 0) return;
    const prompt = queue.shift()!;
    const runGeneration = generation;
    const request = JSON.stringify({ prompt, session_id: sessionId });
    show("user", prompt);
    ctx.ui.setStatus("pi-unreal", "Unreal Agent trabalhando…");

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(runner, [
        "-workspace", ctx.cwd,
        "-session-directory", join(stateRoot, "sessions"),
        "-log-directory", join(stateRoot, "logs"),
        request,
      ], {
        cwd: ctx.cwd,
        env: {
          ...process.env,
          UNREAL_HARNESS_LLM_PROVIDER: "openai-codex",
          UNREAL_HARNESS_LLM_MODEL: model,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      show("error", String(error));
      ctx.ui.setStatus("pi-unreal", "Unreal Agent");
      return;
    }
    active = child;
    child.stdin.end();
    let pending = "";
    let stderr = "";
    let sawResponse = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (runGeneration !== generation) return;
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Event;
          if (event.Kind === "model_response") sawResponse = true;
          renderEvent(event);
        } catch {
          show("error", `Evento JSONL inválido: ${line.slice(0, 300)}`);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { stderr += `${error.message}\n`; });
    child.on("close", (code, signal) => {
      if (runGeneration !== generation) return;
      active = undefined;
      if (pending.trim()) {
        try { renderEvent(JSON.parse(pending)); }
        catch { show("error", `Evento JSONL incompleto: ${pending.slice(0, 300)}`); }
      }
      if (code !== 0) show("error", stderr.trim() || `Runner terminou: ${signal ?? code}`);
      else if (!sawResponse) show("info", "Runner terminou sem resposta do modelo.");
      ctx.ui.setStatus("pi-unreal", "Unreal Agent");
      startNext(ctx);
    });
  }

  pi.registerEntryRenderer<Row>("pi-unreal-row", (entry, _options, theme) => {
    const { kind, text } = entry.data;
    const label = { user: "Você", assistant: "Unreal", reasoning: "Raciocínio", tool: "Ferramenta", error: "Erro", info: "Info" }[kind];
    const color = { user: "accent", assistant: "success", reasoning: "dim", tool: "muted", error: "error", info: "dim" }[kind] as Parameters<typeof theme.fg>[0];
    return new Text(`${theme.fg(color, label)}  ${text}`, 1, 0);
  });

  pi.on("session_start", () => { enabled = false; });

  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    active?.kill("SIGINT");
    active = undefined;
    enabled = false;
    ctx.ui.setStatus("pi-unreal", undefined);
    ctx.ui.setFooter(undefined);
  });

  pi.registerCommand("unreal", {
    description: "Ativar o Unreal Agent no Pi; opcionalmente enviar uma tarefa",
    handler: async (args, ctx) => {
      activate(ctx);
      const prompt = args.trim();
      if (prompt) {
        queue.push(prompt);
        startNext(ctx);
      } else {
        ctx.ui.notify("Unreal Agent ativo. Digite sua tarefa no editor do Pi.", "info");
      }
    },
  });

  pi.registerCommand("unreal-off", {
    description: "Voltar ao agente normal do Pi",
    handler: async (_args, ctx) => {
      if (active) {
        ctx.ui.notify("Interrompa a tarefa atual com /unreal-stop antes de sair.", "warning");
        return;
      }
      enabled = false;
      queue.length = 0;
      ctx.ui.setStatus("pi-unreal", undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("Unreal Agent desativado.", "info");
    },
  });

  pi.registerCommand("unreal-new", {
    description: "Começar uma nova conversa no Unreal Agent",
    handler: async (_args, ctx) => {
      if (!enabled) activate(ctx);
      if (active) {
        ctx.ui.notify("Interrompa a tarefa atual com /unreal-stop antes de começar outra conversa.", "warning");
        return;
      }
      queue.length = 0;
      sessionId = randomUUID();
      writeFileSync(stateFile, JSON.stringify({ sessionId }), { mode: 0o600 });
      writeFileSync(rowsFile, "", { mode: 0o600 });
      show("info", "Nova conversa iniciada.");
    },
  });

  pi.registerCommand("unreal-stop", {
    description: "Interromper a tarefa atual do Unreal Agent",
    handler: async (_args, ctx) => {
      queue.length = 0;
      if (active) active.kill("SIGINT");
      else ctx.ui.notify("Nenhuma tarefa em execução.", "info");
    },
  });

  pi.on("input", (event, ctx) => {
    if (!enabled) return { action: "continue" };
    if (event.source !== "interactive") return { action: "continue" };
    if (event.images?.length) {
      ctx.ui.notify("pi-unreal aceita texto; anexos ainda não são enviados ao runner.", "warning");
      return { action: "handled" };
    }
    const prompt = event.text.trim();
    if (prompt) {
      queue.push(prompt);
      if (active) ctx.ui.notify("Tarefa colocada na fila.", "info");
      startNext(ctx);
    }
    return { action: "handled" };
  });
}
