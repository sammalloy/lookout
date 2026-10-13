#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { resolve } from 'node:path';
import { openDb } from './db.ts';
import { Storage } from './storage.ts';
import { Lookout } from './service.ts';
import { createApp } from './http.ts';

const port = Number(process.env.PORT ?? 4400);
const dataDir = resolve(process.env.LOOKOUT_DATA_DIR ?? '.lookout-data');
const publicUrl = (process.env.LOOKOUT_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');

const db = openDb(dataDir);
const storage = new Storage(dataDir);
const lookout = new Lookout(db, storage, publicUrl);
const server = createApp(lookout, storage, { token: process.env.LOOKOUT_TOKEN });

server.listen(port, () => {
  console.log(`Lookout server on ${publicUrl} (data in ${dataDir})`);
});
