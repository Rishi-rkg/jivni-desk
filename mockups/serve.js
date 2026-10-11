// Tiny viewer for the UI prototype. No packages to install.
//   node mockups/serve.js        then open http://localhost:4173
// Use the "Previous" and "Next" links at the top of each screen, or the left and right arrow keys.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT) || 4173;
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".md": "text/plain" };

http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const file = path.join(root, name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": (types[path.extname(file)] || "application/octet-stream") + "; charset=utf-8", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log("DocHP prototype: http://localhost:" + port));
