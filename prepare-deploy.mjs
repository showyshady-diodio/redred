import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const work = resolve(root, '../../work');
await mkdir(work, { recursive:true });
const destination = await mkdtemp(resolve(work, 'pages-deploy-'));
// Only publish the app and Functions; local connector credentials never enter the upload.
for (const file of ['index.html','404.html','_routes.json','functions']) {
  await cp(resolve(root,file),resolve(destination,file),{recursive:true});
}
console.log(destination);
