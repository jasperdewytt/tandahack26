// Offline copy for the stage laptop: serves public/ on http://localhost:8080 with no internet.
// Presenter mode is always allowed here (it's local), recording/AI endpoints answer "offline",
// so the sample clip plus the presenter/screen tabs still work if the venue network dies.
//   npm run offline   then open  http://localhost:8080/stage?k=local&sample  and  http://localhost:8080/screen
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4", ".webm": "video/webm", ".map": "application/json",
};
const PORT = Number(process.env.PORT ?? 8080);

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/stage") return send(res, 200, "application/json", '{"ok":true}');
  if (url.pathname.startsWith("/api/"))
    return send(res, 503, "application/json", JSON.stringify({ error: "offline", message: "Offline mode: play the sample clip instead." }));
  const file = normalize(join(root, url.pathname));
  if (!file.startsWith(root)) return send(res, 403, "text/plain", "no");
  try {
    return send(res, 200, TYPES[extname(file)] ?? "application/octet-stream", await readFile(file));
  } catch {
    // Single-page app: unknown paths get the app shell.
    return send(res, 200, TYPES[".html"], await readFile(join(root, "index.html")));
  }
}).listen(PORT, () => console.log(`Lip Service offline at http://localhost:${PORT}  (presenter: /stage?k=local&sample, projector: /screen)`));

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}
