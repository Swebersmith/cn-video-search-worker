import { writeFile } from 'node:fs/promises';
import { openapi } from '../src/openapi';
await writeFile('openapi.json', JSON.stringify(openapi, null, 2) + '\n');
