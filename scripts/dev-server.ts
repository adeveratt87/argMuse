/**
 * Local development server: adapts node:http to the Web-standard handlers.
 * Binds to 127.0.0.1 only. Uses the real configuration from the environment.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { getHandlers } from "../src/app.js";

const port = Number(process.env.PORT ?? 3000);
const handlers = getHandlers();

const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html"],
  "/playground.js": ["playground.js", "text/javascript"],
  "/playground.css": ["playground.css", "text/css"],
};

createServer(async (req, res) => {
  const asset = req.method === "GET" ? STATIC[new URL(req.url ?? "/", "http://x").pathname] : undefined;
  if (asset) {
    res.writeHead(200, { "Content-Type": asset[1] });
    res.end(await readFile(new URL(`../../public/${asset[0]}`, import.meta.url)));
    return;
  }
  const ctrl = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ctrl.abort();
  });
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
    signal: ctrl.signal,
  } as RequestInit);
  const response = await handlers.route(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`argos-muse-connector listening on http://127.0.0.1:${port}/mcp`));
