/* Open the reader as a real http:// page, so it can remember things.
 *
 * Double-clicked, reader.html is a file:// page, and a file:// page is an
 * origin with nothing behind it: the two things the reader needs in order not
 * to be handed its archives again on every visit — IndexedDB, where the
 * records can be kept, and the File System Access API, where a saved handle
 * survives a reload — are both keyed to a real origin. http://localhost is
 * one. This server is the smallest thing that can provide it: files read out
 * of this directory, read-only, for as long as the window stays open.
 *
 * Same shape as the test-bed server in %TEMP%\xtbreader\serve.mjs — one
 * directory, CORS, traversal refused before the filesystem is touched — and
 * the same rule: nothing is ever written to disk.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));   /* this file's own directory: reader/ */
const DEFAULT_PORT = 8794;

/* --port=NNNN, or the default. Anything else on the command line is ignored,
   so the .cmd wrapper can pass "%*" through without a stray quote crashing it. */
let port = DEFAULT_PORT;
let openBrowser = true;
for (const arg of process.argv.slice(2)) {
  const m = /^--port=(\d+)$/.exec(arg);
  if (m) port = Number(m[1]);
  else if (arg === '--no-open') openBrowser = false;    /* for automation, not for people */
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('端口不对：' + port + '（应为 1-65535 的数字，例如 --port=8795）');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = createServer((req, res) => {
  let path;
  try {
    path = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (_) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad url');
    return;
  }

  /* Refused on the DECODED path, before normalize() gets to rewrite it: %2e%2e
     IS `..` and %5c IS a backslash, and on Windows a rooted path folds `..`
     away at the root — /../wayback.js becomes \wayback.js there — so a
     traversal is only visibly a traversal at this point. Any `..` segment is
     refused: the reader is one flat directory and never needs one. A drive
     letter (`C:…`) is absolute however it got in. */
  const segments = path.split(/[\\/]/);
  if (segments.includes('..') || /^[A-Za-z]:/.test(path.replace(/^[\\/]+/, ''))) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
       .end('refused: outside the reader directory');
    return;
  }

  const rel = normalize(path).replace(/^[\\/]+/, '');

  const file = rel === '' || rel === '.' ? join(ROOT, 'reader.html') : join(ROOT, rel);
  /* normalize() has already removed every `..`, but the prefix check stays: it
     is what keeps the rule true if this function is ever edited. */
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
       .end('refused: outside the reader directory');
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('missing');
    return;
  }

  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',          /* an edited reader.html shows up on reload */
    'access-control-allow-origin': '*'    /* same shape as the test-bed server */
  });
  res.end(body);
});

/* A taken port is the one failure a double-clicking user will actually meet —
   most likely because a reader window is already open. Say what it means and
   what to do, not a stack trace. */
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('端口 ' + port + ' 已被占用：可能已经有一个阅读器窗口在运行。');
    console.error('请先关掉那个窗口，或换一个端口：node serve.mjs --port=' + (port + 1));
  } else {
    console.error('服务器启动失败：' + err);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = 'http://localhost:' + port + '/reader.html';
  console.log('阅读器已启动：' + url);
  console.log('这个窗口就是服务器，用完关掉它（或按 Ctrl+C）即可。');
  if (openBrowser) launchBrowser(url);
});

/* `start` is a cmd.exe builtin — not an .exe — so it takes `cmd /c`. The empty
   "" is the window title; without it `start` would take the URL as the title
   and open nothing. Detached, so the browser is not a child of this process
   and closing the server window does not close it. */
function launchBrowser(url) {
  if (process.platform !== 'win32') {
    console.log('（非 Windows 系统：请手动打开上面的地址。）');
    return;
  }
  const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
  child.on('error', () => console.error('没能自动打开浏览器，请手动打开上面的地址。'));
  child.unref();
}
