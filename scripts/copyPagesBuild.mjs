import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('docs', { recursive: true });
await copyFile('dist/index.html', 'docs/index.html');
