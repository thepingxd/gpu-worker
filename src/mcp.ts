import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "./app.js";
import { WorkerError } from "./errors.js";
import { log } from "./util.js";
import { VERSION } from "./version.js";

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

const fail = (e: unknown) => {
  const code = e instanceof WorkerError ? e.code : "RUNNER_ERROR";
  const message = e instanceof WorkerError ? e.message : "Erro interno do daemon.";
  if (!(e instanceof WorkerError)) log(`erro inesperado numa tool: ${(e as any)?.stack ?? e}`);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }] };
};

const wrap =
  <A>(fn: (args: A) => Promise<unknown> | unknown) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

export function buildMcpServer(app: App): McpServer {
  const server = new McpServer({ name: "gpu-worker", version: VERSION });

  server.registerTool(
    "list_capabilities",
    {
      description:
        "Mostra a GPU (nome, VRAM), o estado (idle/busy), a fila, os limites e os tipos de job instalados com o JSON Schema dos params. Chame antes de submit_job.",
      inputSchema: {},
    },
    wrap(async () => app.capabilities()),
  );

  server.registerTool(
    "submit_job",
    {
      description:
        "Enfileira um job na GPU local e devolve job_id. Não espera o resultado: consulte com get_job. Os params de cada tipo estão em list_capabilities (params_schema).",
      inputSchema: {
        type: z.string().describe("Ex: comfyui.generate"),
        params: z.record(z.string(), z.unknown()).describe("Params do tipo de job (veja params_schema)."),
        timeout_s: z.number().int().positive().optional().describe("Limite de execução em segundos."),
      },
    },
    wrap(async (a: { type: string; params: Record<string, unknown>; timeout_s?: number }) => {
      const job = await app.jobs.submit(a.type, a.params, a.timeout_s);
      return { job_id: job.id, status: job.status, queue_position: app.jobs.queueLength() };
    }),
  );

  server.registerTool(
    "get_job",
    {
      description:
        "Estado de um job: status (queued|running|done|failed|cancelled), progress 0..1, output.files com URLs temporárias de download, metadata, error e logs_tail.",
      inputSchema: { job_id: z.string() },
    },
    wrap(async (a: { job_id: string }) => app.jobView(app.jobs.get(a.job_id))),
  );

  server.registerTool(
    "cancel_job",
    {
      description: "Cancela um job na fila ou em execução.",
      inputSchema: { job_id: z.string() },
    },
    wrap(async (a: { job_id: string }) => {
      app.jobs.cancel(a.job_id);
      // dá um instante para o runner reagir ao interrupt
      await new Promise((r) => setTimeout(r, 300));
      return app.jobView(app.jobs.get(a.job_id));
    }),
  );

  server.registerTool(
    "list_jobs",
    {
      description: "Lista jobs recentes (mais novos primeiro).",
      inputSchema: {
        status: z.enum(["queued", "running", "done", "failed", "cancelled"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    wrap(async (a: { status?: "queued" | "running" | "done" | "failed" | "cancelled"; limit?: number }) => ({
      jobs: app.jobs.list(a.status, a.limit ?? 20).map((j) => ({
        job_id: j.id,
        type: j.type,
        status: j.status,
        progress: Math.round(j.progress * 100) / 100,
        created_at: j.created_at,
        error: j.error,
      })),
    })),
  );

  server.registerTool(
    "fetch_input",
    {
      description:
        "O daemon baixa um arquivo de uma URL pública e devolve input_id para usar nos jobs. A chamada espera o download terminar. Bloqueia endereços internos. Tipos aceitos: PNG, JPEG, WEBP, GIF e .blend.",
      inputSchema: {
        url: z.string().url(),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe("Se informado, o download é rejeitado se não bater."),
      },
    },
    wrap(async (a: { url: string; sha256?: string }) => app.inputView(await app.inputs.addFromUrl(a.url, a.sha256))),
  );

  server.registerTool(
    "create_upload",
    {
      description:
        "Reserva um input_id e devolve uma URL assinada para enviar o arquivo direto por HTTP PUT (os bytes não passam pelo MCP). O Content-Length deve ser igual a 'size'. Exemplo: curl -T arquivo.png '<url>'",
      inputSchema: {
        name: z.string().min(1).max(200),
        size: z.number().int().positive().describe("Tamanho exato do arquivo em bytes."),
      },
    },
    wrap(async (a: { name: string; size: number }) => {
      const meta = app.inputs.createPending(a.name, a.size);
      const { url, expires_at } = app.uploadUrl(meta.id);
      return { input_id: meta.id, upload: { method: "PUT", url, expires_at, content_length: a.size } };
    }),
  );

  server.registerTool(
    "list_inputs",
    { description: "Lista os inputs presentes na máquina.", inputSchema: {} },
    wrap(async () => ({ inputs: app.inputs.list().map((m) => app.inputView(m)) })),
  );

  server.registerTool(
    "delete_input",
    { description: "Apaga um input.", inputSchema: { input_id: z.string() } },
    wrap(async (a: { input_id: string }) => ({ deleted: app.inputs.delete(a.input_id) })),
  );

  server.registerTool(
    "pin_input",
    {
      description: "Impede que um input expire (limpeza automática), para reutilizá-lo em vários jobs.",
      inputSchema: { input_id: z.string() },
    },
    wrap(async (a: { input_id: string }) => app.inputView(app.inputs.pin(a.input_id))),
  );

  return server;
}
