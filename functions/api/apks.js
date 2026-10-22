import { json } from './_shared.js';

export async function onRequestGet({env}) {
  const {results:packages}=await env.DB.prepare(`SELECT p.id,p.connector_id,p.filename,p.sha256,p.size_bytes,
    i.last_seen_at AS installer_last_seen_at FROM apk_packages p LEFT JOIN apk_installers i ON i.connector_id=p.connector_id
    WHERE p.available=1 ORDER BY p.filename`).all();
  return json(packages.map(p=>({...p,installer_online:Date.now()-Date.parse(p.installer_last_seen_at)<90000})));
}
