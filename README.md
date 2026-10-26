# gpu-worker

Daemon open source que roda na sua máquina, expõe um servidor **MCP** e deixa agentes remotos (Claude, OpenClaw, Hermes, qualquer cliente MCP) usarem a **sua GPU** para gerar imagens e devolver o resultado por uma URL temporária. O agente pode estar num servidor; a GPU é a do usuário.

Estado: **MVP v0.1** (ComfyUI). Blender vem logo depois. Veja `SPEC.md` para o desenho completo.

## Requisitos

- Node.js 20+ (testado em 22)
- GPU NVIDIA com drivers (`nvidia-smi` no PATH)
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

## Limitações conhecidas do v0.1

- **Testado só contra um ComfyUI falso** (`npm run mock`), não contra ComfyUI/GPU reais. Os workflows seguem a API padrão do ComfyUI, mas é o primeiro teste real que vai dizer se algum node ou nome de campo precisa de ajuste. Se falhar, mande o erro de `get_job`/`logs_tail`.
- **Blender ainda não está incluído** (próximo job).
- O daemon **não inicia o ComfyUI**: ele conecta num já em execução.
- A checagem de VRAM usa a **VRAM total** da GPU (a livre pode estar ocupada pelo próprio ComfyUI, com modelos carregados).
- Sem modo de aprovação local por job ainda.
- `fetch_input` é síncrono (a chamada espera o download).
- Plataformas-alvo: Windows e Linux com NVIDIA. AMD/macOS não foram tentados.
- Tokens revogados deixam de valer em até ~5 s no daemon em execução.

## Licença

Dupla: [MIT](LICENSE-MIT) **ou** [Apache-2.0](LICENSE-APACHE), à sua escolha.
