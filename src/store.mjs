import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
export class Store {
  constructor(filename) {
    if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships(group_id TEXT,user_id TEXT,allowed INTEGER,checked_at INTEGER,PRIMARY KEY(group_id,user_id));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,tenant TEXT,group_id TEXT,sender_id TEXT,text TEXT,sent_at INTEGER);
      CREATE TABLE IF NOT EXISTS summaries(id TEXT PRIMARY KEY,message_id TEXT UNIQUE,group_id TEXT,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,owner_id TEXT,summary_id TEXT,payload TEXT NOT NULL,UNIQUE(owner_id,summary_id));
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_id);
      CREATE TABLE IF NOT EXISTS overrides(user_id TEXT,summary_id TEXT,payload TEXT,PRIMARY KEY(user_id,summary_id));
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,payload TEXT,status TEXT NOT NULL DEFAULT 'ready',attempts INTEGER DEFAULT 0,next_at INTEGER DEFAULT 0,lease_until INTEGER DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,task_id TEXT,version INTEGER,payload TEXT,status TEXT NOT NULL DEFAULT 'ready',attempts INTEGER DEFAULT 0,next_at INTEGER DEFAULT 0,lease_until INTEGER DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT,csrf TEXT,expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS oauth_states(hash TEXT PRIMARY KEY,verifier TEXT,expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS mobile_actions(token TEXT PRIMARY KEY,owner_id TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,message_id TEXT);
      CREATE TABLE IF NOT EXISTS mobile_jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ready',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,response TEXT,error TEXT);
    `);
  }
  run(sql,...params){return this.db.prepare(sql).run(...params);}
  get(sql,...params){return this.db.prepare(sql).get(...params);}
  all(sql,...params){return this.db.prepare(sql).all(...params);}
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  close(){this.db.close();}
}

