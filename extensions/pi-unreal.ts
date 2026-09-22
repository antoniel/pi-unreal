import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { rowsFromEvent, type Row, type Event } from "./events.ts";
import { runnerConfig, type RunnerConfig, type Source } from "./provider.ts";

const stateRoot = process.env.PI_UNREAL_STATE_DIR || join(homedir(), ".local", "state", "pi-unreal");
const localRunner = join(homedir(), ".local", "bin", "unreal-agent-runner");
const runner = process.env.PI_UNREAL_RUNNER || (existsSync(localRunner) ? localRunner : "unreal-agent-runner");
const defaultModel = process.env.PI_UNREAL_MODEL || "gpt-6-sol";
const defaultProvider = process.env.PI_UNREAL_PROVIDER || "openai-codex";
const runnerProviders = new Set(["openai-codex", "openai", "openrouter", "fireworks", "ollama"]);

export default function (pi: ExtensionAPI) {
  let mode: "off" | "native" | "runner" = "off";
  let source: Source = process.env.PI_UNREAL_SOURCE === "pi" ? "pi" : "runner";
  let runnerProvider = defaultProvider;
  let runnerModel = defaultModel;
  let starting = false;
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
    starting = false;
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
  }

  function statusLabel(ctx: ExtensionContext) {
    return source === "pi" ? (ctx.model ? `${ctx.model.provider}/${ctx.model.id} (Pi)` : "no Pi model selected") : `${runnerProvider}/${runnerModel}`;
  }

  function stopRunner() {
    // Invalidate callbacks before signalling the runner: a late close/data
    // event must not append rows, restart queued work or overwrite Pi's status.
    generation++;
    const child = active;
    active = undefined;
    starting = false;
    queue.length = 0;
    child?.kill("SIGINT");
  }

  function activateRunner(ctx: ExtensionContext) {
    if (mode === "runner") return;
    reset(ctx);
    mode = "runner";
    // Keep Pi's built-in footer (model, context, tokens and other extensions).
    ctx.ui.setStatus("pi-unreal", `Unreal runner · ${statusLabel(ctx)}`);
  }

  function activateNative(ctx: ExtensionContext) {
    if (mode === "runner") stopRunner();
    mode = "native";
    ctx.ui.setStatus("pi-unreal", "Pi native · Unreal workflow");
  }

  function renderEvent(event: Event) {
    for (const row of rowsFromEvent(event)) show(row.kind, row.text);
  }

  async function startNext(ctx: ExtensionContext) {
    if (active || starting || queue.length === 0) return;
    starting = true;
    const runGeneration = generation;
    let config: RunnerConfig;
    try {
      config = await runnerConfig(ctx, source, runnerProvider, runnerModel);
    } catch (error) {
      if (runGeneration === generation) {
        starting = false;
        queue.length = 0;
        show("error", error instanceof Error ? error.message : String(error));
        ctx.ui.setStatus("pi-unreal", `Unreal runner · ${statusLabel(ctx)}`);
      }
      return;
    }
    if (runGeneration !== generation) return;
    const prompt = queue.shift()!;
    const request = JSON.stringify({ prompt, session_id: sessionId });
    show("user", prompt);
    ctx.ui.setStatus("pi-unreal", `Unreal runner · ${config.label} · working…`);

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
          ...config.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      show("error", String(error));
      ctx.ui.setStatus("pi-unreal", `Unreal runner · ${statusLabel(ctx)}`);
      starting = false;
      return;
    }
    active = child;
    starting = false;
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
          show("error", `Invalid JSONL event: ${line.slice(0, 300)}`);
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
        catch { show("error", `Incomplete JSONL event: ${pending.slice(0, 300)}`); }
      }
      if (code !== 0) show("error", stderr.trim() || `Runner exited: ${signal ?? code}`);
      else if (!sawResponse) show("info", "Runner exited without a model response.");
      ctx.ui.setStatus("pi-unreal", `Unreal runner · ${statusLabel(ctx)}`);
      startNext(ctx);
    });
  }

  pi.registerEntryRenderer<Row>("pi-unreal-row", (entry, _options, theme) => {
    const { kind, text } = entry.data;
    const label = { user: "You", assistant: "Unreal", reasoning: "Reasoning", tool: "Tool", error: "Error", info: "Info" }[kind];
    const color = { user: "accent", assistant: "success", reasoning: "dim", tool: "muted", error: "error", info: "dim" }[kind] as Parameters<typeof theme.fg>[0];
    return new Text(`${theme.fg(color, label)}  ${text}`, 1, 0);
  });

  pi.on("session_start", () => { mode = "off"; });

  // Only a turn-scoped instruction: the Pi still owns the conversation, model,
  // tools, streaming, reasoning widgets and all other extension lifecycle events.
  pi.on("before_agent_start", (event) => {
    if (mode !== "native") return;
    return { systemPrompt: `${event.systemPrompt}\n\nCoding workflow: inspect the project before editing, make focused changes and verify them with relevant checks. Preserve the user's instructions and the tools and context provided by Pi.` };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopRunner();
    mode = "off";
    ctx.ui.setStatus("pi-unreal", undefined);
  });

  pi.registerCommand("unreal", {
    description: "Enable Pi-native workflow (Pi model, tools and UI)",
    handler: async (args, ctx) => {
      activateNative(ctx);
      const prompt = args.trim();
      if (prompt) pi.sendUserMessage(prompt);
      else ctx.ui.notify("Native mode active: using Pi's model, tools, reasoning and extensions.", "info");
    },
  });

  pi.registerCommand("unreal-runner", {
    description: "Enable external Unreal Agent runner (separate tools and session)",
    handler: async (args, ctx) => {
      if (mode !== "runner" && !ctx.isIdle()) {
        ctx.ui.notify("Wait for Pi to finish or interrupt its task before enabling the runner.", "warning");
        return;
      }
      activateRunner(ctx);
      const prompt = args.trim();
      if (prompt) {
        queue.push(prompt);
        startNext(ctx);
      } else ctx.ui.notify("External runner active. Use /unreal to return to Pi-native mode.", "info");
    },
  });

  pi.registerCommand("unreal-model", {
    description: "Use Pi's model connector or choose a runner provider/model",
    handler: async (args, ctx) => {
      const choice = args.trim();
      if (choice !== "pi" && choice !== "runner" && !choice.startsWith("runner ")) {
        ctx.ui.notify("Usage: /unreal-model pi | /unreal-model runner [provider/model]", "info");
        return;
      }
      if (active || starting) {
        ctx.ui.notify("Wait for the task to finish or use /unreal-stop before switching models.", "warning");
        return;
      }
      if (choice.startsWith("runner ")) {
        const selection = choice.slice("runner ".length).trim();
        const slash = selection.indexOf("/");
        const selectedProvider = selection.slice(0, slash);
        const selectedModel = selection.slice(slash + 1);
        if (slash < 1 || !runnerProviders.has(selectedProvider) || !selectedModel || /\s/.test(selectedModel)) {
          ctx.ui.notify("Choose a valid provider/model: openai-codex, openai, openrouter, fireworks or ollama.", "warning");
          return;
        }
        runnerProvider = selectedProvider;
        runnerModel = selectedModel;
      }
      source = choice === "pi" ? "pi" : "runner";
      if (mode === "runner") ctx.ui.setStatus("pi-unreal", `Unreal runner · ${statusLabel(ctx)}`);
      ctx.ui.notify(`External runner model: ${statusLabel(ctx)}. /unreal uses Pi-native mode.`, "info");
    },
  });

  pi.registerCommand("unreal-off", {
    description: "Return to the normal Pi agent",
    handler: async (_args, ctx) => {
      if (mode === "runner") stopRunner();
      mode = "off";
      ctx.ui.setStatus("pi-unreal", undefined);
      ctx.ui.notify("Unreal mode disabled; back to normal Pi.", "info");
    },
  });

  pi.registerCommand("unreal-new", {
    description: "Start a new Unreal Agent conversation",
    handler: async (_args, ctx) => {
      if (mode !== "runner") {
        ctx.ui.notify("/unreal-new is only available in external runner mode. Use /unreal-runner first.", "warning");
        return;
      }
      if (active || starting) {
        ctx.ui.notify("Stop the current task with /unreal-stop before starting a new conversation.", "warning");
        return;
      }
      queue.length = 0;
      sessionId = randomUUID();
      writeFileSync(stateFile, JSON.stringify({ sessionId }), { mode: 0o600 });
      writeFileSync(rowsFile, "", { mode: 0o600 });
      show("info", "New conversation started.");
    },
  });

  pi.registerCommand("unreal-stop", {
    description: "Interrupt the current Unreal Agent task",
    handler: async (_args, ctx) => {
      if (mode !== "runner") {
        ctx.ui.notify("Use Pi's normal interrupt in native mode.", "info");
        return;
      }
      queue.length = 0;
      if (starting && !active) {
        generation++;
        starting = false;
        ctx.ui.setStatus("pi-unreal", `Unreal runner · ${statusLabel(ctx)}`);
      } else if (active) active.kill("SIGINT");
      else ctx.ui.notify("No task is running.", "info");
    },
  });

  pi.on("input", (event, ctx) => {
    if (mode !== "runner") return { action: "continue" };
    if (event.source !== "interactive") return { action: "continue" };
    if (event.images?.length) {
      ctx.ui.notify("pi-unreal accepts text; attachments are not sent to the runner yet.", "warning");
      return { action: "handled" };
    }
    const prompt = event.text.trim();
    if (prompt) {
      queue.push(prompt);
      if (active || starting) ctx.ui.notify("Task queued.", "info");
      startNext(ctx);
    }
    return { action: "handled" };
  });
}
