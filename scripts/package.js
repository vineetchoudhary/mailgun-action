const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.js'));
const destination = path.join(root, 'dist', 'index.js');

if (process.argv.includes('--check')) {
    if (!fs.existsSync(destination) || !source.equals(fs.readFileSync(destination))) {
        console.error('dist/index.js is out of date. Run npm run package and include the updated file.');
        process.exitCode = 1;
    }
} else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, source);
}
