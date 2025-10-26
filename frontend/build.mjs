import { mkdir, readdir, copyFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(rootDir, 'src');
const distDir = join(rootDir, 'dist');

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      if (entry.isDirectory()) {
        await copyDirectory(sourcePath, destinationPath);
        return;
      }
      if (entry.isFile()) {
        await copyFile(sourcePath, destinationPath);
      }
    }),
  );
}

async function build() {
  await rm(distDir, { recursive: true, force: true });
  await copyDirectory(srcDir, distDir);
  console.log(`Copied static assets from ${srcDir} to ${distDir}`);
}

async function clean() {
  try {
    const stats = await stat(distDir);
    if (stats) {
      await rm(distDir, { recursive: true, force: true });
      console.log(`Removed ${distDir}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

const command = process.argv[2];
if (command === '--clean') {
  await clean();
} else {
  await build();
}
