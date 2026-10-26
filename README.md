# gpu-worker

Daemon open source que roda na sua máquina, expõe um servidor **MCP** e deixa agentes remotos (Claude, OpenClaw, Hermes, qualquer cliente MCP) usarem a **sua GPU** para gerar imagens e devolver o resultado por uma URL temporária. O agente pode estar num servidor; a GPU é a do usuário.

Estado: **MVP v0.2** (ComfyUI). Blender vem logo depois. Veja `SPEC.md` para o desenho completo.

## Requisitos

- Node.js 20+ (testado em 22)
- Uma GPU que o ComfyUI consiga usar. O alvo do MVP é **NVIDIA** (drivers + `nvidia-smi`); AMD, Intel Arc e Apple Silicon devem funcionar porque a detecção pergunta ao próprio ComfyUI, mas **não foram testados**. Vídeo integrado só serve para testar o fluxo (a geração roda em CPU e é muito lenta)
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) rodando (padrão `http://127.0.0.1:8188`) com **ao menos um checkpoint** instalado
- [Tailscale](https://tailscale.com/) instalado e conectado, na máquina da GPU e na máquina do agente (para teste só local na mesma máquina, não precisa)

## Instalação

```bash
npm install
npm run build        # o zip já traz dist/, mas rebuilde se mexer no código
node dist/cli.js init
```

`init` cria `~/.gpu-worker/config.json`, gera um token e mostra uma vez. Se o Tailscale estiver conectado, faz bind no IP da tailnet; senão, fica em `127.0.0.1` (só teste local). Opções: `--bind tailscale|IP`, `--port N`, `--comfyui URL`, `--force`.

```bash
node dist/cli.js doctor   # confere Node, GPU, bind e ComfyUI
node dist/cli.js start    # sobe o daemon
```

(Com `npm link` ou instalação global, os comandos viram `gpu-worker init|doctor|start`.)

## Testar em 2 minutos

Com o ComfyUI e o daemon rodando, em outro terminal, na pasta do projeto:

```bash
GW_URL=http://<ip-do-bind>:8787/mcp GW_TOKEN=<token> npm run smoke
```

O smoke faz o que um agente faria: `list_capabilities`, `txt2img`, download pela URL temporária (salva em `smoke-out/`), upload + `img2img`, rejeição de arquivo inválido, bloqueio de endereço interno, parâmetros inválidos, cancelamento e token errado. Variáveis úteis: `GW_STEPS` (padrão 8), `GW_SKIP=upload,cancel,ssrf`, `GW_FETCH_URL=<imagem pública>`.

Sem GPU/ComfyUI para testar? `npm run mock` sobe um ComfyUI falso na porta 8188 que valida a estrutura dos workflows.

## Conectar um agente

Qualquer cliente MCP com transporte HTTP (streamable):

```json
{
  "mcpServers": {
    "gpu-worker": {
      "type": "http",
      "url": "http://<ip-da-tailnet>:8787/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

O agente precisa estar na mesma tailnet. Um token por agente: `gpu-worker token add <nome>` / `list` / `revoke <nome>`.

## Notebooks

O daemon foi ajustado para rodar em notebook:

- **GPU detectada pelo ComfyUI** (`/system_stats`), que é quem de fato usa o dispositivo; o `nvidia-smi` complementa (versão do driver) e serve de fallback. Se o ComfyUI estiver em CPU enquanto o `nvidia-smi` vê uma placa NVIDIA (notebook híbrido com o ComfyUI na GPU errada), o `list_capabilities` e o `doctor` mostram um aviso.
- **Keep-awake:** enquanto há job rodando (ou na fila), o daemon impede a suspensão por inatividade (`systemd-inhibit` no Linux, `caffeinate` no macOS, `SetThreadExecutionState` no Windows). **Fechar a tampa ainda suspende** na maioria dos sistemas: ajuste "ao fechar a tampa" para "não fazer nada" enquanto na tomada.
- **Bateria:** `list_capabilities` informa `power` (na bateria, %). Fora da tomada, jobs são recusados abaixo de `power.min_battery_percent` (padrão 20%); com `power.on_battery: "block"`, são recusados sempre. A checagem é só na hora de enfileirar; um job já em execução não é interrompido se a carga cair.
- **Tailscale:** com `bind: "tailscale"`, o daemon espera até `tailscale_wait_s` (padrão 120 s) o Tailscale conectar, em vez de falhar ao ligar o notebook ou trocar de rede.

Configuração (em `config.json`):

```json
{
  "tailscale_wait_s": 120,
  "power": { "on_battery": "allow", "min_battery_percent": 20, "keep_awake": true }
}
```

Para testar a política de bateria sem desligar da tomada: `GPU_WORKER_FAKE_POWER=battery:15 node dist/cli.js start` (também `ac:80` e `none`).

### Iniciar com o sistema

```bash
node dist/cli.js service install     # systemd (usuário) | launchd | Tarefa Agendada do Windows
node dist/cli.js service status
node dist/cli.js service uninstall
node dist/cli.js service install --dry-run   # só mostra o que seria criado
```

Roda o `start` no login e reinicia se cair. No Linux, para subir no boot sem login: `sudo loginctl enable-linger $USER`. No Windows a tarefa é criada permitindo rodar na bateria. Logs: `journalctl --user -u gpu-worker -f` (Linux), `~/.gpu-worker/daemon.log` (macOS e Windows; no macOS sem rotação).

## Tools MCP

| Tool | O que faz |
|---|---|
| `list_capabilities` | GPU, VRAM, estado, fila, limites, jobs instalados e `params_schema` |
| `submit_job` | Enfileira `{type, params, timeout_s?}` e devolve `job_id` |
| `get_job` | `status`, `progress`, `output.files[]` com URL temporária, `metadata`, `error`, `logs_tail` |
| `cancel_job` / `list_jobs` | Cancela / lista |
| `fetch_input` | O daemon baixa uma URL pública e devolve `input_id` |
| `create_upload` | URL assinada para `PUT` direto (os bytes não passam pelo MCP) |
| `list_inputs` / `delete_input` / `pin_input` | Gerenciam os inputs na máquina |

### `comfyui.generate`

Presets: `txt2img`, `img2img`, `upscale`. Parâmetros principais: `prompt`, `negative_prompt`, `width`, `height`, `steps`, `cfg`, `denoise` (img2img), `seed`, `batch`, `model`, `upscale_model`, `input_id`. O agente **nunca** envia workflow cru. `upscale` só aparece se houver um modelo de upscale instalado no ComfyUI.

Erros: `INVALID_PARAMS`, `INSUFFICIENT_VRAM`, `JOB_UNAVAILABLE`, `INPUT_NOT_FOUND`, `INPUT_REJECTED`, `QUEUE_FULL`, `TIMEOUT`, `CANCELLED`, `RUNNER_ERROR`.

## Segurança (resumo)

- Escuta só no IP da tailnet (ou IP explícito); `0.0.0.0` é recusado.
- Bearer token por agente (guardado só como hash) + URLs de upload/download assinadas com HMAC e TTL curto (15 min).
- Só jobs registrados, sem shell e sem workflow cru; ComfyUI é acessado só pela API.
- `fetch_input`: bloqueia IPs internos/loopback/CGNAT (anti-SSRF, validado também na conexão), limita redirects e tamanho, aceita allowlist de domínios (`fetch.allowlist` na config).
- Tipo do arquivo validado pelo conteúdo (magic bytes), não pela extensão.
- Limpeza automática de inputs e outputs após 24 h (`pin_input` mantém um input).

## Limitações conhecidas

- **Testado só contra um ComfyUI falso** (`npm run mock`), não contra ComfyUI/GPU reais. Os workflows seguem a API padrão do ComfyUI, mas é o primeiro teste real que vai dizer se algum node ou nome de campo precisa de ajuste. Se falhar, mande o erro de `get_job`/`logs_tail`.
- **Blender ainda não está incluído** (próximo job).
- O daemon **não inicia o ComfyUI**: ele conecta num já em execução.
- A checagem de VRAM usa a **VRAM total** da GPU (a livre pode estar ocupada pelo próprio ComfyUI, com modelos carregados).
- Sem modo de aprovação local por job ainda.
- `fetch_input` é síncrono (a chamada espera o download).
- **Só testei em Linux.** A detecção de bateria, o keep-awake e a instalação do serviço no **Windows e macOS** foram escritos a partir da documentação dos sistemas e testados apenas com saídas simuladas (parsers e arquivos gerados; o Linux também foi testado com `systemctl` e `systemd-inhibit` simulados). Se algo falhar nessas plataformas, mande a saída de `doctor` e do `service`.
- AMD, Intel e Apple Silicon: a detecção usa o ComfyUI, mas nunca rodei em nenhuma dessas placas.
- Tokens revogados deixam de valer em até ~5 s no daemon em execução.

## Licença

Dupla: [MIT](LICENSE-MIT) **ou** [Apache-2.0](LICENSE-APACHE), à sua escolha.
