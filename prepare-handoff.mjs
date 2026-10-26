import { readdir,readFile,writeFile,mkdir,mkdtemp,cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname,resolve,relative,extname,basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(import.meta.url)),work=resolve(root,'../../work');
await mkdir(work,{recursive:true});const destination=await mkdtemp(resolve(work,'shared-source-'));
const files=[];
for(const name of await readdir(root))if(/\.md$/i.test(name)&&name!=='HANDOFF.md'||['index.html','404.html','_routes.json','schema.sql','package.json','wrangler.toml','.gitignore'].includes(name)||/^(setup-local|prepare-deploy|prepare-handoff|configure-device-control|configure-production-connector)\.mjs$/.test(name))files.push(name);
async function sources(folder){
  for(const item of await readdir(resolve(root,folder),{withFileTypes:true})){
    if(item.name.startsWith('.')||/\.local\.(json|mjs|js|ps1)$/.test(item.name))continue;
    const path=folder+'/'+item.name;
    if(item.isDirectory()){if(folder!=='connector')await sources(path);continue;}
    if(['.js','.mjs','.ps1','.sql'].includes(extname(item.name))||folder==='connector'&&item.name==='connector.example.json')files.push(path);
  }
}
for(const folder of ['functions','connector','tests','migrations'])await sources(folder);
const hashes=[];
for(const file of files.sort()){
  const target=resolve(destination,file);if(relative(destination,target).startsWith('..'))throw new Error('Unexpected source path');
  await mkdir(dirname(target),{recursive:true});await cp(resolve(root,file),target);
  hashes.push(createHash('sha256').update(await readFile(target)).digest('hex')+'  '+file);
}
await writeFile(resolve(destination,'MANIFEST.sha256'),hashes.join('\n')+'\n');
console.log(JSON.stringify({directory:destination,files:files.length,archive:basename(destination)+'.zip',credentials_included:false}));
