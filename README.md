# pi-unreal

A [Pi](https://pi.dev/) extension that runs the real [Unreal Agent](https://github.com/unreallabsai/unreal-agent) underneath Pi's UI:

- **`/unreal` (default — hybrid):** spawns the actual `unreal-agent-runner` process and lets it own the full orchestration — coordinator loop, session, skills, fault tolerance, its own tools. Pi stays on top: editor, status line, rendered entries, queue and commands. The extension injects a coding-workflow addendum into the runner's *system prompt* and maps Pi's `/thinking` level to the runner's `thinking_level`.
- **`/unreal-native` (fallback):** no runner involved. Pi's own agent runs with workflow instructions added to the turn's system prompt. Pi fully owns the model from `/model`, authentication, reasoning/streaming, tools, widgets, sessions and other extensions' events.

`/unreal-runner` is kept as an alias of `/unreal`.

The hybrid mode **is** the Unreal Agent runtime: the runner process is the agent. `/unreal-native` is not — it uses Pi's agent with a coding workflow prompt, and needs no Go or runner binary.

## Installation

### Default (hybrid) mode

Requires [Pi](https://pi.dev/), Git, Go 1.27+, and a Pi model configured (`/login`, `/model`). Install the package directly from Git, then the runner executable:

```sh
pi install git:github.com/antoniel/pi-unreal
GOBIN="$HOME/.local/bin" go install github.com/unreallabsai/unreal-agent/cmd/unreal-agent-runner@latest
pi list
```

Alternatively, from a local checkout:

```sh
git clone https://github.com/antoniel/pi-unreal.git
cd pi-unreal
pi install "$(pwd)"
GOBIN="$HOME/.local/bin" go install github.com/unreallabsai/unreal-agent/cmd/unreal-agent-runner@latest
pi list
```

A local-path install refers to that checkout; keep it in place. Git installs are managed by Pi and can be updated with `pi update --extensions`.

The extension looks for `~/.local/bin/unreal-agent-runner` first, then searches `PATH`. You can override the location with `PI_UNREAL_RUNNER`. If you use the runner's default Codex provider, also install the Codex CLI and run `codex login` before starting a task.

The runner's default provider is `openai-codex` with `gpt-6-sol`. For a Codex subscription, run `codex login`: the runner reads the Codex CLI credential from `~/.codex/auth.json` or `CODEX_HOME/auth.json`, but does not refresh tokens — log in again if it expires. To choose another runner provider/model, use `/unreal-model runner openrouter/openai/gpt-4.1`, for example, with the corresponding runner credential (`OPENROUTER_API_KEY` in this example).

### Native-only mode

If you only want `/unreal-native` (Pi's own agent, no Unreal runtime), Pi and Git are enough — skip Go and the runner binary.

## Usage

Open Pi in the project you want to work on:

```sh
cd /path/to/project
pi
```

| Command | Effect |
| --- | --- |
| `/unreal` or `/unreal Your task` | **Default (hybrid):** runs the real Unreal Agent as the backend with Pi's UI on top, optionally queueing an initial task. |
| `/unreal-runner` | Alias of `/unreal` (kept for compatibility). |
| `/unreal-native` or `/unreal-native Your task` | Runs **Pi's own agent** with workflow instructions in the system prompt; no runner process is started. |
| `/unreal-off` | Stops the runner (discarding its queue) or leaves native mode, returning to normal Pi. |
| `/unreal-stop` | Interrupts the current **runner** task and clears its queue; in native mode, use Pi's normal interrupt. |
| `/unreal-new` | Starts a new **runner** conversation; in native mode, use Pi's session commands. |
| `/unreal-model pi` | **Runner modes only:** resolves Pi's current model and credential per task (must be an OpenAI Responses model; see below). Not needed in `/unreal-native`. |
| `/unreal-model runner [provider/model]` | **Runner modes only:** selects the runner's own provider/model; optionally changes the selection without restarting Pi. |

Hybrid activation waits until Pi is idle (interrupt any running Pi task first). In `/unreal-native`, `/model`, tools, reasoning, attachments, history and widgets keep working exactly as usual in Pi — there is no parallel rendering and no footer replacement. `/unreal-off` removes the extra instructions on future turns; it does not change a Pi response that has already started.

## How the hybrid mode wires into the runner

```text
Pi editor → extension → unreal-agent-runner → Unreal Agent model and tools
    ↑             ← session JSONL events ←
    └──────────── rendered entries in the Pi terminal
```

The runner is the agent: its own coordinator, session store, tools (`bash`, `view_image`, `skill-use`) and retry/fault-tolerance logic run in the external process. The extension contributes two things on top:

- **System prompt injection.** The runner *replaces* its default harness prompt when a request sets `system_prompt`, so the extension resends the harness default and appends the coding-workflow instructions (inspect before editing, focused changes, verify with relevant checks, preserve the user's instructions and the harness's tools/session).
- **Thinking-level mapping.** Pi's current `/thinking` level is forwarded as the runner's `thinking_level`. The runner accepts `low`, `medium`, `high`, `xhigh`, `max`; Pi's `off` and `minimal` are clamped to `low`, and when Pi exposes no level the field is omitted so the runner applies its own default.

You can also use `/unreal-model pi` to resolve Pi's current model and credential for each new task. This only works with `api: openai-responses` models from runner-supported providers (`openai`, `openrouter`, or `fireworks`), an API key, and no extra headers. Other protocols (Anthropic, Gemini, OpenAI Completions, Pi's ChatGPT login, etc.) are incompatible: the extension warns you **before** launching the runner and does not send the token to another provider. Even with `/unreal-model pi`, the runner still uses its own tools, session and events — not Pi's.

Runner conversation state persists across Pi restarts in the same project. It is stored outside the project in `~/.local/state/pi-unreal/`: runner sessions and logs, plus the visual history. `/unreal-new` changes the runner's conversation context; older messages may remain visible until you reopen Pi. The extension does not store credentials in its state; in the runner's Pi-model mode, it only passes the key through the child process environment.

| Environment variable | Purpose (runner) |
| --- | --- |
| `PI_UNREAL_MODEL` | Default runner model; `gpt-6-sol`. |
| `PI_UNREAL_PROVIDER` | Default runner provider (`openai-codex`, `openai`, `openrouter`, `fireworks`, `ollama`); `openai-codex`. |
| `PI_UNREAL_SOURCE` | Set to `pi` to start **the runner** with a compatible Pi model; defaults to `runner`. Does not affect `/unreal-native`. |
| `PI_UNREAL_RUNNER` | Path to a different `unreal-agent-runner` executable. |
| `PI_UNREAL_STATE_DIR` | Alternative directory for runner sessions, logs, and visual history. |

**Runner limitations:** events arrive after each response, not token by token (the runner currently ignores `include_partial_messages`). Images attached in Pi's editor are not sent to the runner. The runner's tool calls and reasoning are not published as native Pi events, so other Pi extensions that depend on those events do not receive them. When the provider returns a readable reasoning summary, it appears on a separate line; when it returns only encrypted content, the extension shows only the reasoning token count. Tasks submitted while another runner task is active are queued.

## Development

The package uses the [Pi extension API](https://pi.dev/docs/latest/extensions) and [runner events](https://github.com/unreallabsai/unreal-agent/blob/main/cmd/unreal-agent-runner/README.md). Pi loads TypeScript directly. To run the tests, install Bun and execute:

```sh
bun test tests
```
