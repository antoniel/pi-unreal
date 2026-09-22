import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-tui", () => ({ Text: class {
  constructor(public text: string) {}
} }));
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Exercise the real command/input handlers against a fake runner that captures
// every request JSON and emits a late response after cancellation. No Pi
// installation or model credentials needed.
test("hybrid /unreal drives the real runner with Pi's UI and switches safely to /unreal-native", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-unreal-switch-"));
  const runner = join(dir, "runner.cjs");
  const launches = join(dir, "launches");
  const requestsFile = join(dir, "requests.jsonl");
  const configFile = join(dir, "config.json");
  writeFileSync(runner, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(launches)}, 'start\\n');
fs.appendFileSync(${JSON.stringify(requestsFile)}, process.argv[process.argv.length - 1] + '\\n');
fs.writeFileSync(${JSON.stringify(configFile)}, JSON.stringify({ provider: process.env.UNREAL_HARNESS_LLM_PROVIDER, model: process.env.UNREAL_HARNESS_LLM_MODEL, key: process.env.UNREAL_HARNESS_LLM_API_KEY }));
process.on('SIGINT', () => {
  process.stdout.write(JSON.stringify({ Kind: 'model_response', Data: { Response: {
    Output: [{ Type: 'message', Data: { Role: 'assistant', Text: 'late response' } }]
  } } }) + '\\n');
  setTimeout(() => process.exit(0), 20);
});
setTimeout(() => process.exit(0), 600);
`);
  chmodSync(runner, 0o755);
  const previousRunner = process.env.PI_UNREAL_RUNNER;
  const previousState = process.env.PI_UNREAL_STATE_DIR;
  process.env.PI_UNREAL_RUNNER = runner;
  process.env.PI_UNREAL_STATE_DIR = dir;
  try {
    const { default: extension } = await import("../extensions/pi-unreal.ts");
    const commands = new Map<string, any>();
    const handlers = new Map<string, any>();
    const statuses: Array<string | undefined> = [];
    const notifications: string[] = [];
    const rows: any[] = [];
    let footerCalls = 0;
    const sent: string[] = [];
    let renderer: any;
    const pi = {
      registerCommand: (name: string, command: any) => commands.set(name, command),
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerEntryRenderer: (_name: string, render: any) => { renderer = render; },
      appendEntry: (_type: string, row: any) => rows.push(row),
      sendUserMessage: (message: string) => sent.push(message),
    };
    const ctx = {
      cwd: dir,
      isIdle: () => true,
      sessionManager: { getEntries: () => [] },
      ui: {
        setStatus: (_key: string, text: string | undefined) => statuses.push(text),
        setFooter: () => { footerCalls++; },
        notify: (message: string) => notifications.push(message),
      },
    };
    const launchCount = () => (existsSync(launches) ? readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).length : 0);
    const requests = () => (existsSync(requestsFile) ? readFileSync(requestsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
    const waitLaunches = async (count: number) => {
      for (let i = 0; i < 300 && (launchCount() < count || requests().length < count); i++) await sleep(10);
    };

    extension(pi as any);

    // 1. /unreal-native keeps Pi's own agent, model and tools.
    await commands.get("unreal-native").handler("", ctx);
    expect(statuses.at(-1)).toContain("Pi native");
    expect(handlers.get("input")({ text: "native prompt", images: [{ type: "image" }], source: "interactive" }, ctx)).toEqual({ action: "continue" });
    expect(handlers.get("before_agent_start")({ systemPrompt: "other extensions" }).systemPrompt).toContain("other extensions\n\nCoding workflow:");
    await commands.get("unreal-native").handler("inline prompt", ctx);
    expect(sent).toEqual(["inline prompt"]);
    expect(launchCount()).toBe(0);

    // Runner-only commands refuse to run without the runner.
    await commands.get("unreal-new").handler("", ctx);
    expect(notifications.at(-1)).toContain("only available while the Unreal runner is active");
    await commands.get("unreal-stop").handler("", ctx);
    expect(notifications.at(-1)).toContain("not active; use Pi's normal interrupt");

    // 2. Hybrid activation waits for an idle Pi.
    (ctx as any).isIdle = () => false;
    await commands.get("unreal").handler("", ctx);
    expect(notifications.at(-1)).toContain("Wait for Pi to finish");
    expect(launchCount()).toBe(0);
    expect(statuses.at(-1)).toContain("Pi native");
    (ctx as any).isIdle = () => true;

    // 3. /unreal-off drops the native instructions.
    await commands.get("unreal-off").handler("", ctx);
    expect(handlers.get("before_agent_start")({ systemPrompt: "unchanged" })).toBeUndefined();
    expect(statuses.at(-1)).toBeUndefined();
    expect(notifications.at(-1)).toContain("Unreal mode disabled");

    // 4. /unreal (hybrid): the real runner underneath, Pi's UI on top.
    (ctx as any).thinkingLevel = "high";
    await commands.get("unreal").handler("", ctx);
    expect(notifications.at(-1)).toContain("runner runs underneath");
    expect(statuses.at(-1)).toContain("Unreal runner ·");
    expect(handlers.get("before_agent_start")({ systemPrompt: "must stay untouched" })).toBeUndefined();
    expect(footerCalls).toBe(0);
    expect(renderer({ data: { kind: "assistant", text: "hello" } }, {}, { fg: (_color: string, text: string) => text }).text).toContain("Unreal  hello");
    expect(handlers.get("input")({ text: "pic", images: [{ type: "image" }], source: "interactive" }, ctx)).toEqual({ action: "handled" });
    expect(notifications.at(-1)).toContain("attachments are not sent");
    expect(launchCount()).toBe(0);
    expect(handlers.get("input")({ text: "first", source: "interactive" }, ctx)).toEqual({ action: "handled" });
    await waitLaunches(1);
    const [first] = requests();
    expect(first.prompt).toBe("first");
    expect(first.session_id).toBeTruthy();
    expect(first.system_prompt).toContain("isolated sandbox container");
    expect(first.system_prompt).toContain("Coding workflow:");
    expect(first.system_prompt).toContain("harness's tools and session");
    expect(first.thinking_level).toBe("high");

    // 5. Queueing then /unreal-off discards queued work and late responses.
    handlers.get("input")({ text: "queued", source: "interactive" }, ctx);
    expect(notifications.at(-1)).toContain("Task queued.");
    await commands.get("unreal-off").handler("", ctx);
    expect(statuses.at(-1)).toBeUndefined();
    expect(handlers.get("input")({ text: "now Pi", source: "interactive" }, ctx)).toEqual({ action: "continue" });
    await sleep(120);
    expect(launchCount()).toBe(1);
    expect(rows.some((row) => row.text === "late response" || row.text === "queued")).toBe(false);
    expect(statuses.at(-1)).toBeUndefined();

    // 6. /unreal-runner is an alias; runner model selection validates input.
    await commands.get("unreal-runner").handler("", ctx);
    expect(statuses.at(-1)).toContain("Unreal runner ·");
    expect(footerCalls).toBe(0);
    await commands.get("unreal-model").handler("runner openai/gpt-4.1", ctx);
    expect(statuses.at(-1)).toContain("openai/gpt-4.1");
    expect(notifications.at(-1)).toContain("Runner model:");
    await commands.get("unreal-model").handler("runner unsupported/model", ctx);
    expect(statuses.at(-1)).toContain("openai/gpt-4.1");
    expect(notifications.at(-1)).toContain("Choose a valid provider/model");

    // 7. Pi connector resolves auth on demand; cancelling never launches.
    (ctx as any).model = { provider: "openai", id: "gpt-4.1", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
    let finishAuth!: (auth: any) => void;
    (ctx as any).modelRegistry = { getApiKeyAndHeaders: () => new Promise((resolve) => { finishAuth = resolve; }) };
    await commands.get("unreal-model").handler("pi", ctx);
    handlers.get("input")({ text: "cancel during auth", source: "interactive" }, ctx);
    await commands.get("unreal-off").handler("", ctx);
    finishAuth({ ok: true, apiKey: "fake-key" });
    await sleep(30);
    expect(launchCount()).toBe(1);
    expect(statuses.at(-1)).toBeUndefined();

    // 8. Pi connector passes credentials to the runner; Pi's "off" clamps to low.
    (ctx as any).modelRegistry = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake-key" }) };
    (ctx as any).thinkingLevel = "off";
    await commands.get("unreal-runner").handler("", ctx);
    expect(statuses.at(-1)).toContain("openai/gpt-4.1 (Pi)");
    handlers.get("input")({ text: "using Pi connector", source: "interactive" }, ctx);
    await waitLaunches(2);
    expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ provider: "openai", model: "gpt-4.1", key: "fake-key" });
    const second = requests()[1];
    expect(second.system_prompt).toContain("Coding workflow:");
    expect(second.thinking_level).toBe("low");
    expect(second.session_id).toBe(first.session_id);
    expect(JSON.stringify(rows)).not.toContain("fake-key");

    // 9. With no Pi thinking level exposed, the runner applies its own default.
    delete (ctx as any).thinkingLevel;
    handlers.get("input")({ text: "third", source: "interactive" }, ctx);
    expect(notifications.at(-1)).toContain("Task queued.");
    await waitLaunches(3);
    const third = requests()[2];
    expect(third.prompt).toBe("third");
    expect(third.thinking_level).toBeUndefined();

    // 10. /unreal-native stops the runner; its late response never renders.
    await commands.get("unreal-native").handler("", ctx);
    expect(handlers.get("input")({ text: "back to Pi", source: "interactive" }, ctx)).toEqual({ action: "continue" });
    expect(statuses.at(-1)).toContain("Pi native");
    await sleep(120);
    expect(rows.some((row) => row.text === "late response")).toBe(false);
    expect(statuses.at(-1)).toContain("Pi native");
    handlers.get("session_shutdown")({}, ctx);
    expect(statuses.at(-1)).toBeUndefined();
  } finally {
    if (previousRunner === undefined) delete process.env.PI_UNREAL_RUNNER;
    else process.env.PI_UNREAL_RUNNER = previousRunner;
    if (previousState === undefined) delete process.env.PI_UNREAL_STATE_DIR;
    else process.env.PI_UNREAL_STATE_DIR = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});
