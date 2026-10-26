// ComfyUI falso, só para testar o gpu-worker sem GPU.
// Implementa o mínimo da API: object_info, upload/image, prompt, history, view, interrupt, queue.
// Uso: node scripts/mock-comfyui.mjs   (porta 8188; MOCK_PORT e MOCK_DELAY_MS ajustam)
import http from "node:http";
import zlib from "node:zlib";

const PORT = Number(process.env.MOCK_PORT ?? 8188);
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 2000);
const DEVICE = process.env.MOCK_DEVICE ?? "cuda"; // cuda | cpu | mps

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w = 64, h = 64) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255) / w;
      raw[o + 1] = (y * 255) / h;
      raw[o + 2] = 128;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = makePng();
const history = new Map();
const timers = new Map();
let counter = 0;

function send(res, status, body, type = "application/json") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(data) });
  res.end(data);
}
const readBody = (req) =>
  new Promise((resolve) => {
    const c = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => resolve(Buffer.concat(c)));
  });

function validate(prompt) {
  const ids = new Set(Object.keys(prompt));
  let hasSave = false;
  for (const [id, node] of Object.entries(prompt)) {
    if (!node.class_type) return `nó ${id} sem class_type`;
    if (node.class_type === "SaveImage") hasSave = true;
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && !ids.has(String(v[0]))) return `nó ${id}.${k} referencia nó inexistente ${v[0]}`;
      if (v === null || v === undefined) return `nó ${id}.${k} sem valor`;
    }
  }
  return hasSave ? null : "workflow sem SaveImage";
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p === "/system_stats") {
      const GiB = 1024 ** 3;
      const devices = {
        cuda: [{ name: "cuda:0 Mock GeForce RTX 4060 Laptop GPU : cudaMallocAsync", type: "cuda", index: 0, vram_total: 8 * GiB, vram_free: 6.5 * GiB }],
        mps: [{ name: "mps:0 Apple M2", type: "mps", index: 0, vram_total: 16 * GiB, vram_free: 10 * GiB }],
        cpu: [{ name: "cpu", type: "cpu", index: null, vram_total: 16 * GiB, vram_free: 8 * GiB }],
      }[DEVICE] ?? [];
      return send(res, 200, { system: { os: "mock", comfyui_version: "mock" }, devices });
    }
    if (p === "/object_info/CheckpointLoaderSimple") {
      return send(res, 200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["mock-sd15.safetensors"]] } } } });
    }
    if (p === "/object_info/UpscaleModelLoader") {
      return send(res, 200, { UpscaleModelLoader: { input: { required: { model_name: [["mock-4x.pth"]] } } } });
    }
    if (p === "/upload/image" && req.method === "POST") {
      const body = (await readBody(req)).toString("latin1");
      const name = /filename="([^"]+)"/.exec(body)?.[1] ?? "upload.png";
      console.log(`[mock] upload/image ${name}`);
      return send(res, 200, { name, subfolder: "", type: "input" });
    }
    if (p === "/prompt" && req.method === "POST") {
      const { prompt } = JSON.parse((await readBody(req)).toString());
      const problem = validate(prompt);
      const text = Object.values(prompt).find((n) => n.class_type === "CLIPTextEncode")?.inputs?.text ?? "";
      if (problem) return send(res, 400, { error: { message: problem }, node_errors: {} });
      if (String(text).includes("FAIL")) return send(res, 400, { error: { message: "prompt de teste rejeitado" }, node_errors: {} });
      const id = `mock-${++counter}-${Date.now()}`;
      console.log(`[mock] prompt ${id}: ${Object.values(prompt).map((n) => n.class_type).join(",")}`);
      timers.set(
        id,
        setTimeout(() => {
          history.set(id, {
            outputs: { 9: { images: [{ filename: `mock_${counter}_.png`, subfolder: "", type: "output" }] } },
            status: { status_str: "success", completed: true, messages: [] },
          });
          timers.delete(id);
        }, DELAY),
      );
      return send(res, 200, { prompt_id: id, number: counter, node_errors: {} });
    }
    if (p.startsWith("/history/")) {
      const id = p.slice("/history/".length);
      return send(res, 200, history.has(id) ? { [id]: history.get(id) } : {});
    }
    if (p === "/view") return send(res, 200, PNG, "image/png");
    if (p === "/sample.png") return send(res, 200, PNG, "image/png");
    if (p === "/interrupt" && req.method === "POST") {
      console.log("[mock] interrupt");
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      return send(res, 200, {});
    }
    if (p === "/queue" && req.method === "POST") {
      await readBody(req);
      return send(res, 200, {});
    }
    send(res, 404, { error: "not found" });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`[mock] ComfyUI falso em http://127.0.0.1:${PORT} (delay ${DELAY} ms)`));
