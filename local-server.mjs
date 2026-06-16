import { createServer } from "node:http";
import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";

const require = createRequire(import.meta.url);
const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const apiHandlers = {
  "/api/scanner": require("./api/scanner"),
  "/api/quote": require("./api/quote"),
  "/api/history": require("./api/history"),
  "/api/exchange": require("./api/exchange"),
};
const upstreamBase = String(process.env.KBK_API_UPSTREAM || "").trim().replace(/\/$/, "");
const apiLogPath = join(root, "work", "local-server-api.log");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function createApiResponse(res) {
  let statusCode = 200;
  return {
    setHeader(name, value) {
      res.setHeader(name, value);
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      if (!res.headersSent) {
        res.writeHead(statusCode, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": String(res.getHeader("cache-control") || "no-store"),
        });
      }
      res.end(JSON.stringify(payload));
      return this;
    },
    send(payload) {
      if (!res.headersSent) {
        res.writeHead(statusCode, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": String(res.getHeader("cache-control") || "no-store"),
        });
      }
      res.end(payload);
      return this;
    },
  };
}

async function logApiRequest(url, source) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    path: url.pathname,
    search: url.search,
    source,
  });
  await appendFile(apiLogPath, `${line}\n`).catch(() => {});
}

async function proxyApi(req, res, url) {
  const response = await fetch(`${upstreamBase}${url.pathname}${url.search}`, {
    headers: { accept: req.headers.accept || "application/json" },
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
  });
  res.end(body);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const apiHandler = apiHandlers[url.pathname];

    if (apiHandler) {
      await logApiRequest(url, "local");
      await apiHandler(req, createApiResponse(res));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (upstreamBase) {
        await logApiRequest(url, "proxy");
        await proxyApi(req, res, url);
        return;
      }
      send(res, 404, `No local handler for ${url.pathname}. Set KBK_API_UPSTREAM to enable explicit proxy fallback.`);
      return;
    }

    const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = normalize(join(root, requestPath));
    if (!filePath.startsWith(root)) {
      send(res, 403, "Forbidden");
      return;
    }

    try {
      const body = await readFile(filePath);
      send(res, 200, body, contentTypes[extname(filePath)] || "application/octet-stream");
    } catch (_error) {
      const body = await readFile(join(root, "index.html"));
      send(res, 200, body, contentTypes[".html"]);
    }
  } catch (error) {
    send(res, 404, error instanceof Error ? error.message : "Not found");
  }
}).listen(port, () => {
  console.log(`Local scanner server: http://localhost:${port}`);
  console.log(`API proxy fallback: ${upstreamBase || "disabled"}`);
});
