const fs = require('node:fs');

fs.mkdirSync('dist', { recursive: true });
for (const directory of ['css', 'js', 'assets']) {
  fs.rmSync(`dist/${directory}`, { recursive: true, force: true });
  fs.cpSync(directory, `dist/${directory}`, { recursive: true, filter: source => !/(^|[\\/])(?:uploads|\.[^\\/]+)([\\/]|$)/.test(source) });
}
fs.copyFileSync('index.html', 'dist/index.html');
fs.copyFileSync('server/admin.html', 'dist/admin.html');
