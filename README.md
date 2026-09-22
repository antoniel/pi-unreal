# pi-unreal

A [Pi](https://pi.dev/) extension with two modes:

- **`/unreal` (default):** a **Pi-native** coding workflow. Pi still manages the model selected with `/model`, authentication, reasoning and streaming, tools, widgets, sessions, and events from other extensions. This extension only adds workflow guidance to the turn's system prompt; it does not replace Pi's settings.
- **`/unreal-runner` (optional):** runs the actual [Unreal Agent](https://github.com/unreallabsai/unreal-agent) in an external process with its own tools and session. Runner tool calls and reasoning are not emitted as native Pi events, so other Pi extensions that rely on those events **will not** receive them.

The native mode **is not the Unreal Agent runtime**: it uses Pi's agent with a coding workflow. Use `/unreal-runner` if you need the Unreal Agent runtime and accept this separation.

## Installation

For native mode, install [Pi](https://pi.dev/) and configure a Pi model (for example, with `/login` and `/model`). Then install this package directly from Git:

```sh
pi install git:github.com/antoniel/pi-unreal
pi list
```

Alternatively, to work from a local checkout, install Git, clone the repository, and register its directory with Pi:

```sh
git clone https://github.com/antoniel/pi-unreal.git
cd pi-unreal
pi install "$(pwd)"
pi list
```

A local-path install refers to that checkout; keep it in place. Git installs are managed by Pi and can be updated with `pi update --extensions`. Neither installation method requires Go for native mode.

To use the **optional external runner**, install Go 1.27+ and its executable:

```sh
mkdir -p "$HOME/.local/bin"
GOBIN="$HOME/.local/bin" go install github.com/unreallabsai/unreal-agent/cmd/unreal-agent-runner@latest
```

The extension looks for `~/.local/bin/unreal-agent-runner` first, then searches `PATH`. You can override the location with `PI_UNREAL_RUNNER`. If you use the runner's default Codex provider, also install the Codex CLI and run `codex login` before starting a task. The runner is not required for `/unreal`.

## Usage

Open Pi in the project you want to work on:

```sh
cd /path/to/project
pi
```

| Command | Effect |
| --- | --- |
| `/unreal` or `/unreal Your task` | Enables **Pi-native mode**, optionally sending a task to Pi. Does not start the runner. |
| `/unreal-runner` or `/unreal-runner Your task` | Enables the external runner; subsequent interactive messages go to it. Wait for or interrupt any active Pi task before switching. |
| `/unreal-off` | Disables native mode or stops the runner (discarding its queue) and returns to normal Pi. |
| `/unreal-stop` | Interrupts the current **runner** task and clears its queue; in native mode, use Pi's normal interrupt. |
| `/unreal-new` | Starts a new **runner** conversation; in native mode, use Pi's session commands. |
| `/unreal-model pi` | **Runner only:** uses a compatible Pi model and its credential. Not needed in native mode. |
| `/unreal-model runner [provider/model]` | **Runner only:** returns to the runner's own provider/model; optionally changes the selection without restarting Pi. |

In native mode, `/model`, tools, reasoning, attachments, history, and widgets continue working as usual in Pi. There is no parallel rendering or footer replacement. `/unreal-off` removes the extra instructions on future turns; it does not change a Pi response that has already started.

## External runner (optional)

```text
Pi editor → extension → unreal-agent-runner → Unreal Agent model and tools
    ↑             ← session JSONL events ←
    └──────────── separate terminal rendering
```

The runner defaults to `openai-codex` with `gpt-6-sol`, **only in this mode**. For a Codex subscription, run `codex login`: the runner reads the Codex CLI credential from `~/.codex/auth.json` or `CODEX_HOME/auth.json`, but does not refresh tokens. Log in again if it expires. To choose another runner provider/model, use `/unreal-model runner openrouter/openai/gpt-4.1`, for example, with the corresponding runner credential (`OPENROUTER_API_KEY` in this example).

You can also use `/unreal-model pi` **in runner mode** to resolve Pi's current model and credential for each new task. This only works with `api: openai-responses` models from runner-supported providers (`openai`, `openrouter`, or `fireworks`), an API key, and no extra headers. Other protocols (Anthropic, Gemini, OpenAI Completions, Pi's ChatGPT login, etc.) are incompatible: the extension warns you **before** launching the runner and does not send the token to another provider. To use those connectors, tools, and widgets without adaptation, use Pi-native `/unreal`. Even with `/unreal-model pi`, the runner does not use Pi's tools, reasoning events, or extensions.

Runner conversation state persists across Pi restarts in the same project. It is stored outside the project in `~/.local/state/pi-unreal/`: runner sessions and logs, plus the visual history. `/unreal-new` changes the runner's conversation context; older messages may remain visible until you reopen Pi. The extension does not store credentials in its state; in the runner's Pi-model mode, it only passes the key through the child process environment.

| Environment variable | Purpose (external runner) |
| --- | --- |
| `PI_UNREAL_MODEL` | Default runner model; `gpt-6-sol`. |
| `PI_UNREAL_PROVIDER` | Default runner provider (`openai-codex`, `openai`, `openrouter`, `fireworks`, `ollama`); `openai-codex`. |
| `PI_UNREAL_SOURCE` | Set to `pi` to start **the runner** with a compatible Pi model; defaults to `runner`. Does not affect `/unreal`. |
| `PI_UNREAL_RUNNER` | Path to a different `unreal-agent-runner` executable. |
| `PI_UNREAL_STATE_DIR` | Alternative directory for runner sessions, logs, and visual history. |

**Runner limitations:** events arrive after each response, not token by token. Images attached in Pi's editor are not sent to the runner. When the provider returns a readable reasoning summary, it appears on a separate line; when it returns only encrypted content, the extension shows only the reasoning token count. Tasks submitted while another runner task is active are queued.

## Development

The package uses the [Pi extension API](https://pi.dev/docs/latest/extensions) and [runner events](https://github.com/unreallabsai/unreal-agent/blob/main/cmd/unreal-agent-runner/README.md). Pi loads TypeScript directly. To run the tests, install Bun and execute:

```sh
bun test tests
```
