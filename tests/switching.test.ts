import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-tui", () => ({ Text: class {
  constructor(public text: string) {}
} }));
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Exercise the real input/command handlers and a runner that emits a late
// response after cancellation. No Pi installation or model credentials needed.
test("defaults to Pi-native tools/UI and switches safely to and from the external runner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-unreal-switch-"));
  const runner = join(dir, "runner.cjs");
  const launches = join(dir, "launches");
  const configFile = join(dir, "config.json");
  writeFileSync(runner, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(launches)}, 'start\\n');
fs.writeFileSync(${JSON.stringify(configFile)}, JSON.stringify({ provider: process.env.UNREAL_HARNESS_LLM_PROVIDER, model: process.env.UNREAL_HARNESS_LLM_MODEL, key: process.env.UNREAL_HARNESS_LLM_API_KEY }));
process.on('SIGINT', () => {
  process.stdout.write(JSON.stringify({ Kind: 'model_response', Data: { Response: {
    Output: [{ Type: 'message', Data: { Role: 'assistant', Text: 'late response' } }]
  } } }) + '\\n');
  setTimeout(() => process.exit(0), 20);
});
setTimeout(() => process.exit(0), 2000);
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
        notify: () => {},
      },
    };
    extension(pi as any);
    await commands.get("unreal").handler("", ctx);
    expect(statuses.at(-1)).toContain("Pi native");
    expect(handlers.get("input")({ text: "native prompt", images: [{ type: "image" }], source: "interactive" }, ctx)).toEqual({ action: "continue" });
    expect(handlers.get("before_agent_start")({ systemPrompt: "other extensions" }).systemPrompt).toContain("other extensions\n\nCoding workflow:");
    await commands.get("unreal").handler("inline prompt", ctx);
    expect(sent).toEqual(["inline prompt"]);
    expect(existsSync(launches)).toBe(false);
    (ctx as any).isIdle = () => false;
    await commands.get("unreal-runner").handler("", ctx);
    expect(existsSync(launches)).toBe(false);
    expect(statuses.at(-1)).toContain("Pi native");
    (ctx as any).isIdle = () => true;
    await commands.get("unreal-off").handler("", ctx);
    expect(handlers.get("before_agent_start")({ systemPrompt: "unchanged" })).toBeUndefined();
    await commands.get("unreal-runner").handler("", ctx);
    expect(statuses.at(-1)).toContain("Unreal runner ·");
    expect(footerCalls).toBe(0);
    expect(renderer({ data: { kind: "assistant", text: "hello" } }, {}, { fg: (_color: string, text: string) => text }).text).toContain("Unreal  hello");
    expect(handlers.get("input")({ text: "first", source: "interactive" }, ctx)).toEqual({ action: "handled" });
    for (let i = 0; i < 100 && !existsSync(launches); i++) await sleep(10);
    expect(existsSync(launches)).toBe(true);
    handlers.get("input")({ text: "queued", source: "interactive" }, ctx);
    await commands.get("unreal-off").handler("", ctx);
    expect(statuses.at(-1)).toBeUndefined();
    expect(handlers.get("input")({ text: "now Pi", source: "interactive" }, ctx)).toEqual({ action: "continue" });
    await sleep(120);
    expect(readFileSync(launches, "utf8").trim().split("\n")).toHaveLength(1);
    expect(rows.some((row) => row.text === "late response" || row.text === "queued")).toBe(false);
    expect(statuses.at(-1)).toBeUndefined();
    await commands.get("unreal-runner").handler("", ctx);
    expect(statuses.at(-1)).toContain("Unreal runner ·");
    expect(footerCalls).toBe(0);
    await commands.get("unreal-model").handler("runner openai/gpt-4.1", ctx);
    expect(statuses.at(-1)).toContain("openai/gpt-4.1");
    await commands.get("unreal-model").handler("runner unsupported/model", ctx);
    expect(statuses.at(-1)).toContain("openai/gpt-4.1");
    (ctx as any).model = { provider: "openai", id: "gpt-4.1", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
    let finishAuth!: (auth: any) => void;
    (ctx as any).modelRegistry = { getApiKeyAndHeaders: () => new Promise((resolve) => { finishAuth = resolve; }) };
    await commands.get("unreal-model").handler("pi", ctx);
    handlers.get("input")({ text: "cancel during auth", source: "interactive" }, ctx);
    await commands.get("unreal-off").handler("", ctx);
    finishAuth({ ok: true, apiKey: "fake-key" });
    await sleep(30);
    expect(readFileSync(launches, "utf8").trim().split("\n")).toHaveLength(1);
    expect(statuses.at(-1)).toBeUndefined();
    (ctx as any).modelRegistry = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake-key" }) };
    await commands.get("unreal-runner").handler("", ctx);
    expect(statuses.at(-1)).toContain("openai/gpt-4.1 (Pi)");
    handlers.get("input")({ text: "using Pi connector", source: "interactive" }, ctx);
    for (let i = 0; i < 100 && readFileSync(launches, "utf8").trim().split("\n").length < 2; i++) await sleep(10);
    expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ provider: "openai", model: "gpt-4.1", key: "fake-key" });
    expect(JSON.stringify(rows)).not.toContain("fake-key");
    await commands.get("unreal").handler("", ctx);
    expect(handlers.get("input")({ text: "back to Pi", source: "interactive" }, ctx)).toEqual({ action: "continue" });
    expect(statuses.at(-1)).toContain("Pi native");
    await sleep(60);
    expect(rows.some((row) => row.text === "late response")).toBe(false);
    expect(statuses.at(-1)).toContain("Pi native");
    handlers.get("session_shutdown")({}, ctx);
  } finally {
    if (previousRunner === undefined) delete process.env.PI_UNREAL_RUNNER;
    else process.env.PI_UNREAL_RUNNER = previousRunner;
    if (previousState === undefined) delete process.env.PI_UNREAL_STATE_DIR;
    else process.env.PI_UNREAL_STATE_DIR = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});
