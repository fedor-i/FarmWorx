import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function fileStore(dir) {
  return (file, base64) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), Buffer.from(base64, 'base64'));
  };
}
