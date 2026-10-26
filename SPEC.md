# gpu-worker: SPEC (rascunho v0.3)

> Nome: `gpu-worker`. Licença: dupla, **MIT OR Apache-2.0** (o usuário escolhe uma). Este documento cobre só o MVP.

## 1. Visão

Um daemon open source que roda na máquina do usuário, detecta a GPU local e expõe um servidor MCP. Qualquer agente que fale MCP (Claude, OpenClaw, Hermes etc.), mesmo rodando em servidor, pode submeter um job gráfico, esperar o processamento na GPU do usuário e receber o resultado de forma limpa.

Princípios:
- **Agnóstico a agente:** só MCP, sem SDK proprietário.
- **Tools fechadas:** o agente escolhe um job registrado e preenche parâmetros. Não existe shell livre nem workflow cru.
- **Assíncrono:** `submit_job` devolve um id e o agente consulta depois.
- **Resultado previsível:** todo job devolve o mesmo envelope.
- **Zero porta aberta pra internet:** transporte via Tailscale no MVP.

## 2. Escopo do MVP

Dentro:
- Daemon em Node + TypeScript
- Jobs: `comfyui.generate` (primeiro) e `blender.render` (logo depois)
- Transporte: Tailscale
- Entrada de arquivos: `fetch_input` (URL) e `create_upload` (PUT direto)
- Saída: URL de download temporária servida pelo próprio daemon
- Fila com um job por vez na GPU

Fora (futuro):
- Relay próprio / Cloudflare Tunnel
- Múltiplas GPUs e execução paralela
- Instalador gráfico para público não técnico
- Marketplace de plugins de job
- Jobs de transcrição e ffmpeg

## 3. Arquitetura

```
Agente (servidor)  --MCP sobre HTTP (tailnet)-->  Daemon (máquina do usuário)
                                                    ├─ MCP server
                                                    ├─ Fila + scheduler (1 job por vez)
                                                    ├─ Runners (comfyui, blender)
                                                    ├─ Store de inputs / outputs
                                                    └─ Servidor de arquivos (PUT / GET assinados)
```

Estrutura do repositório:

```
gpu-worker/
├─ daemon/        # MCP server, fila, detecção de GPU
├─ jobs/
│  ├─ comfyui/    # manifesto + runner + presets
│  └─ blender/    # manifesto + runner
├─ transport/     # tailscale (MVP)
├─ schemas/       # JSON Schema de entrada e saída
├─ installer/     # setup + download de modelos sob demanda
└─ SPEC.md
```

Cada job é um plugin com `manifest.json` (tipo, schema de params, requisitos de VRAM) e um `runner`.

## 4. Transporte e autenticação (Tailscale)

- O daemon escuta **somente** no IP da interface da tailnet, nunca em `0.0.0.0`.
- O agente entra na mesma tailnet com uma tag (ex: `tag:agent`). A ACL libera apenas a porta do daemon.
- Autenticação adicional por **bearer token** por conexão, gerado no setup e revogável.
- URLs de upload e download são **assinadas (HMAC)**, com TTL curto, e só alcançáveis dentro da tailnet.
- Transporte MCP: HTTP streamable.

## 5. Tools do MCP

| Tool | Descrição |
|---|---|
| `list_capabilities` | GPU, VRAM total/livre, drivers, jobs instalados, presets, modelos, limites, status (`idle`/`busy`) |
| `submit_job` | `{ type, params, timeout_s? }` devolve `{ job_id }` |
| `get_job` | Estado, progresso, output, erro e logs |
| `cancel_job` | Cancela job em fila ou em execução |
| `list_jobs` | Jobs recentes, com filtro por status |
| `fetch_input` | `{ url, sha256? }` baixa e devolve `input_id` |
| `create_upload` | `{ name, size }` devolve URL de upload (PUT) e `input_id` pendente |
| `list_inputs` | Inputs presentes na máquina |
| `delete_input` | Remove um input |
| `pin_input` | Impede a limpeza automática de um input reutilizável |

### 5.1 `list_capabilities` (resposta)

```json
{
  "gpu": { "name": "NVIDIA RTX 4070", "vram_total_mb": 12288, "vram_free_mb": 10900, "driver": "..." },
  "status": "idle",
  "queue_length": 0,
  "limits": { "max_input_mb": 2048, "max_output_mb": 4096, "default_timeout_s": 600 },
  "jobs": [
    { "type": "comfyui.generate", "presets": ["txt2img", "img2img", "upscale"], "models": ["..."], "min_vram_mb": 6000 },
    { "type": "blender.render", "engines": ["CYCLES", "EEVEE"], "devices": ["OPTIX", "CUDA"], "min_vram_mb": 4000 }
  ]
}
```

## 6. Envelope de job

`submit_job` recebe `{ type, params, timeout_s? }`. `get_job` devolve:

```json
{
  "job_id": "string",
  "type": "comfyui.generate",
  "status": "queued | running | done | failed | cancelled",
  "progress": 0.0,
  "output": {
    "files": [
      { "name": "out_0001.png", "mime": "image/png", "size": 123456, "sha256": "...", "url": "...", "expires_at": "ISO-8601" }
    ]
  },
  "metadata": { "duration_s": 0, "model": "", "seed": 0, "gpu": "" },
  "error": { "code": "", "message": "" },
  "logs_tail": []
}
```

Regras:
- `error` é `null` quando não há erro.
- `logs_tail` mantém só as últimas ~20 linhas, já filtradas (sem caminhos locais nem dados sensíveis).
- `progress` é monotônico e vai de 0 a 1.
- Estados finais: `done`, `failed`, `cancelled`.

### 6.1 Códigos de erro

| Código | Quando |
|---|---|
| `INVALID_PARAMS` | Params não passam no schema |
| `INSUFFICIENT_VRAM` | Job exige mais VRAM do que a máquina tem |
| `JOB_UNAVAILABLE` | Tipo de job, preset ou modelo não instalado |
| `INPUT_NOT_FOUND` | `input_id` inexistente ou expirado |
| `INPUT_REJECTED` | Falhou validação de tipo, tamanho, domínio ou checksum |
| `QUEUE_FULL` | Fila cheia |
| `TIMEOUT` | Excedeu `timeout_s` |
| `CANCELLED` | Cancelado pelo agente |
| `RUNNER_ERROR` | Falha interna do runner |

## 7. Jobs

### 7.1 `comfyui.generate`

Parâmetros:
- `preset`: workflow registrado (`txt2img`, `img2img`, `upscale`)
- `prompt`, `negative_prompt?`
- `width`, `height`, `steps`, `seed?`, `batch?`
- `model?` (precisa estar instalado)
- `input_id?` (obrigatório em `img2img` e `upscale`)

Regras:
- O agente **nunca** envia workflow JSON cru. O daemon injeta as variáveis no preset.
- Presets e custom nodes são curados pelo mantenedor. Custom nodes arbitrários ficam fora do MVP, porque podem executar código.
- O runner fala com a API local do ComfyUI (ComfyUI roda como processo filho, só em loopback).

### 7.2 `blender.render`

Parâmetros:
- `scene_input_id`: id de um `.blend` já recebido
- `engine`: `CYCLES | EEVEE`
- `frame` **ou** `frame_start` + `frame_end`
- `resolution` (`[w, h]`), `samples?`
- `device`: `OPTIX | CUDA | AUTO`
- `format`: `PNG | EXR | MP4`

Regras:
- Sempre executa com `--background` e `--disable-autoexec`, porque `.blend` pode carregar scripts Python.
- Roda com um usuário/ambiente restrito quando possível e sem acesso à rede.
- Texturas externas devem estar empacotadas no `.blend`. Referências a caminhos absolutos são rejeitadas.

## 8. Entrada de arquivos

Dois caminhos, mesmo resultado (`input_id`):

1. **`fetch_input(url, sha256?)`**: o daemon baixa.
2. **`create_upload(name, size)`**: devolve URL de PUT assinada (TTL curto, só na tailnet). O agente envia o arquivo por HTTP e os bytes **não passam pelo MCP**.

Proteções:
- Limite de tamanho por arquivo e cota total da pasta de inputs.
- Verificação de `sha256` quando informado.
- `fetch_input`: allowlist de domínios configurável, bloqueio de IPs internos, loopback e link-local (anti-SSRF), limite de redirects.
- Tipo validado pelo **conteúdo** (magic bytes), não pela extensão.
- Limpeza automática por TTL (padrão 24h). `pin_input` desativa a expiração.

## 9. Saída de arquivos

- Cada job escreve em uma pasta isolada `outputs/<job_id>/`.
- `output.files[].url` é uma URL assinada servida pelo daemon, com TTL de 15 min.
- Se o TTL expirar, `get_job` gera uma nova URL enquanto o arquivo ainda existir.
- Retenção padrão de outputs: 24h, com limpeza automática.

## 10. Fila e agendamento

- Um job por vez na GPU (MVP). Os demais ficam em `queued`, em ordem FIFO.
- Tamanho máximo de fila configurável.
- `timeout_s` padrão de 600 e teto configurável. Ao estourar, o runner é encerrado e o job vai para `failed` com `TIMEOUT`.
- Estado da fila persistido em disco. Se o daemon reiniciar, jobs `running` viram `failed` (`RUNNER_ERROR`) e os `queued` são retomados.
- Se a GPU estiver ocupada por outro processo (ex: jogo), `list_capabilities` reflete `vram_free_mb` e jobs que não cabem falham rápido com `INSUFFICIENT_VRAM`.

## 11. Segurança

- Execução só de jobs registrados, sem shell e sem workflow cru.
- Bind exclusivo na interface da tailnet, mais ACL por tag, mais bearer token.
- Runners em processos separados, com diretório de trabalho próprio e variáveis de ambiente mínimas.
- Blender com `--disable-autoexec`; ComfyUI só em loopback e só com nodes aprovados.
- Anti-SSRF no `fetch_input`; validação de conteúdo por magic bytes.
- Logs sem caminhos locais, tokens ou URLs assinadas.
- Rate limit por token.
- Modo de aprovação opcional: o usuário pode exigir confirmação local antes de cada job (útil para máquinas pessoais).

## 12. Instalação (MVP)

- CLI: `gpu-worker init` detecta GPU e drivers, gera token e configura o Tailscale.
- Modelos são baixados sob demanda, com checksum, e a CLI informa o tamanho antes.
- ComfyUI e Blender podem ser detectados no sistema ou instalados em pasta gerenciada pelo daemon.
- Plataformas: Windows e Linux com NVIDIA primeiro. AMD e macOS ficam como futuro.

## 12.1 Notebooks (adicionado na v0.3)

- **Detecção de GPU:** o `list_capabilities` obtém a GPU do ComfyUI (`/system_stats`), que é o dispositivo que de fato roda os jobs, com `nvidia-smi` como complemento (driver) e fallback. Campos novos: `gpu.backend`, `gpu.source` e `warnings[]` (ex: ComfyUI em CPU com NVIDIA presente).
- **Energia:** `list_capabilities.power` informa bateria e política. Config `power.on_battery` (`allow|block`) e `power.min_battery_percent`; violar a política devolve `JOB_UNAVAILABLE`. Checagem só no `submit_job`.
- **Keep-awake:** inibe a suspensão por inatividade enquanto há fila ou job (config `power.keep_awake`). Fechar a tampa não é coberto.
- **Rede:** com `bind: "tailscale"`, espera o Tailscale por `tailscale_wait_s` ao iniciar.
- **Autostart:** `gpu-worker service install|uninstall|status` (systemd de usuário, launchd, Tarefa Agendada do Windows).

## 13. Critérios de aceite do MVP

1. `list_capabilities` reporta GPU e VRAM corretamente.
2. Um agente remoto, via tailnet, gera uma imagem com `txt2img` e baixa o arquivo pela URL temporária.
3. `img2img` funciona com input enviado por `create_upload` e por `fetch_input`.
4. `blender.render` renderiza um frame de um `.blend` enviado, com `--disable-autoexec`.
5. Cancelamento, timeout e `INSUFFICIENT_VRAM` retornam o erro correto no envelope.
6. Reiniciar o daemon não corrompe a fila.
7. Nada acessível fora da tailnet.

## 14. Decisões fechadas

- **Nome:** `gpu-worker` (pacote npm livre na checagem de 26/10/2026; confirmar na hora de publicar).
- **Licença:** dupla `MIT OR Apache-2.0`. O repo terá `LICENSE-MIT` e `LICENSE-APACHE`, e o `package.json` usa `"license": "(MIT OR Apache-2.0)"`.

## 15. Questões em aberto

- Formato de distribuição do daemon (npm global, binário único, Docker com GPU).
- Política de modelos: quais vêm no catálogo oficial e quais o usuário adiciona.
- Cloudflare Tunnel como segundo transporte, depois de validar Tailscale.
- Eventos/streaming de progresso (SSE) em vez de polling.
