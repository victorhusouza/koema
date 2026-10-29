import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ownerExists } from '../lib/auth.ts';

export function testSession(path:string) {
 const previous=process.env.PAINEL_DB_PATH;
 process.env.PAINEL_DB_PATH=path;
 try {
  ownerExists();
 } finally {
  if(previous===undefined)delete process.env.PAINEL_DB_PATH;
  else process.env.PAINEL_DB_PATH=previous;
 }
 const database=new DatabaseSync(path);
 database.prepare("INSERT OR IGNORE INTO koema_owner(id,username,password_hash,password_salt,created_at) VALUES (1,'test-owner','test-hash','test-salt',?)").run(Date.now());
 const token=randomBytes(32).toString('hex');
 database.prepare('INSERT INTO koema_sessions(token_hash,owner_id,created_at,expires_at,absolute_expires_at,last_seen_at) VALUES (?,1,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),Date.now(),Date.now()+7*86400000,Date.now()+30*86400000,Date.now());
 database.close();
 return {token,headers:{Cookie:`koema_session=${token}`} as HeadersInit};
}
