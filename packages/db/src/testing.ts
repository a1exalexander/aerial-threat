// Integration-test helper: a throwaway database per call on the shared Postgres (docker compose / CI service).
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb } from './client';
import { migrate } from './migrate';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://aerial:aerial@localhost:54329/postgres';

export async function createTestDb() {
  const adminUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const name = `aerial_t_${randomBytes(6).toString('hex')}`;
  const admin = () => postgres(adminUrl, { max: 1, onnotice: () => {} });

  const create = admin();
  await create.unsafe(`create database ${name}`);
  await create.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await migrate(url.toString());
  const { db, sql, close } = createDb(url.toString(), { max: 5 });

  return {
    db,
    sql,
    url: url.toString(),
    drop: async () => {
      await close();
      const drop = admin();
      await drop.unsafe(`drop database if exists ${name} with (force)`);
      await drop.end();
    },
  };
}
