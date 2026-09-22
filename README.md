# pi-unreal

Extensão do [Pi](https://pi.dev/) que usa o [Unreal Agent](https://github.com/unreallabsai/unreal-agent) como agente de código. Você continua digitando no Pi; a extensão envia a tarefa ao `unreal-agent-runner` e renderiza as respostas e chamadas de ferramenta. Ao ativá-la, o modelo e as ferramentas do Pi não executam essas tarefas.

## Instalar

Você precisa ter Pi, Git e Go 1.27+ instalados. Para usar a assinatura Codex, faça login na Codex CLI com sua conta ChatGPT:

```sh
codex login
```

Clone este repositório **no seu computador** e registre a pasta como um pacote do Pi:

```sh
git clone https://github.com/antoniel/pi-unreal.git
cd pi-unreal
pi install "$(pwd)"
```

Instale o executável do Unreal Agent:

```sh
GOBIN="$HOME/.local/bin" go install github.com/unreallabsai/unreal-agent/cmd/unreal-agent-runner@latest
```

A extensão procura `~/.local/bin/unreal-agent-runner` primeiro e depois o `PATH`. Para conferir o registro, rode `pi list`.

## Usar dentro do Pi

Entre na pasta do projeto em que o agente vai trabalhar e abra o Pi normalmente:

```sh
cd /caminho/do/projeto
pi
```

No editor do Pi, digite **`/unreal`**. A partir daí, mensagens comuns vão para o Unreal Agent. Você também pode iniciar com `/unreal Sua tarefa aqui`.

| Comando | Efeito |
| --- | --- |
| `/unreal` | Ativa o Unreal Agent para a conversa atual. |
| `/unreal-off` | Volta ao agente normal do Pi. |
| `/unreal-stop` | Interrompe a tarefa atual e limpa a fila. |
| `/unreal-new` | Inicia outra conversa do Unreal Agent no projeto. |

As tarefas enviadas enquanto outra está em execução ficam na fila. A conversa do Unreal Agent continua entre reinícios do Pi no mesmo projeto. `/unreal-new` troca o contexto do agente; as mensagens antigas podem continuar visíveis até você reabrir o Pi.

## Como funciona

```text
editor do Pi → extensão → unreal-agent-runner → modelo e ferramentas do Unreal Agent
     ↑              ← eventos JSONL da sessão ←
     └──────────── renderização no terminal
```

A extensão intercepta a mensagem digitada quando `/unreal` está ativo, envia um pedido JSON com `prompt` e `session_id` ao runner e desenha os eventos JSONL como **Você**, **Unreal**, **Raciocínio** e **Ferramenta**. Sem ativar `/unreal`, o Pi continua funcionando normalmente. A extensão não substitui nem modifica o runtime do Pi.

O provedor padrão é `openai-codex`, com modelo `gpt-6-sol`. Ele usa a credencial existente da Codex CLI em `~/.codex/auth.json` ou `CODEX_HOME/auth.json`; uma chave `OPENAI_API_KEY` não é necessária nesse fluxo. O runner não faz login nem renova tokens. Se a credencial expirar, execute `codex login` novamente.

O estado fica em `~/.local/state/pi-unreal/`, fora do projeto: sessões e logs do runner, além do histórico visual por projeto. O histórico visual não substitui a sessão do agente. A extensão não copia credenciais para esse diretório.

### Configuração opcional

Defina variáveis de ambiente antes de abrir o Pi:

| Variável | Uso |
| --- | --- |
| `PI_UNREAL_MODEL` | Escolhe outro modelo; o padrão é `gpt-6-sol`. |
| `PI_UNREAL_RUNNER` | Caminho para outro executável `unreal-agent-runner`. |
| `PI_UNREAL_STATE_DIR` | Diretório alternativo para sessões, logs e histórico visual. |

**Limites atuais:** o runner emite eventos após cada resposta do modelo; não há texto token a token. Anexos de imagem do editor do Pi ainda não são enviados ao runner. Quando o provedor fornece um resumo de reasoning, a extensão o exibe. Quando só devolve conteúdo criptografado, a extensão mostra apenas a contagem de tokens de reasoning.

## Desenvolvimento

O pacote usa a [API de extensões do Pi](https://pi.dev/docs/latest/extensions) e os [eventos do runner](https://github.com/unreallabsai/unreal-agent/blob/main/cmd/unreal-agent-runner/README.md). O Pi carrega o TypeScript diretamente, sem uma etapa de compilação. Para rodar os testes, instale Bun e execute:

```sh
bun test tests
```
