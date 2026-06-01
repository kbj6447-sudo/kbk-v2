import { cp, mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await copyFile('index.html', 'dist/index.html');
await cp('assets', 'dist/assets', { recursive: true });
await cp('legacy', 'dist/legacy', { recursive: true });
