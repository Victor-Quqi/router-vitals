import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
const root = resolve(process.argv[2] ?? "status-page");
const port = Number(process.argv[3] ?? 8788);
const contentTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml; charset=utf-8"]
]);
function resolvePath(urlPath) {
    const cleanPath = decodeURIComponent(urlPath.split("?")[0] ?? "/");
    const candidate = resolve(join(root, cleanPath === "/" ? "index.html" : cleanPath));
    if (candidate !== root && !candidate.startsWith(root + sep))
        return null;
    if (existsSync(candidate) && statSync(candidate).isFile())
        return candidate;
    return null;
}
createServer((req, res) => {
    const filePath = resolvePath(req.url ?? "/");
    if (!filePath) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
    }
    res.writeHead(200, { "content-type": contentTypes.get(extname(filePath)) ?? "application/octet-stream" });
    createReadStream(filePath).pipe(res);
}).listen(port, "127.0.0.1", () => {
    console.log(`Serving ${root} at http://127.0.0.1:${port}`);
});
