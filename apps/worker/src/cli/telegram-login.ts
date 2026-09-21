// `cli telegram-login`: interactive admin login of the collector's service account (doc 04 B.1, doc 08).
// Writes the GramJS StringSession to the file named by TELEGRAM_SESSION_SECRET_REF (mode 0600).
// The session is never printed; prompts go to stderr and the 2FA password is not echoed.
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { WorkerEnv, parseEnv } from '@aerial/config';
import { sessionPath, writeSession } from '@aerial/telegram/live';
import { Logger, TelegramClient } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';

export async function run(argv: string[]): Promise<number> {
  const env = parseEnv(WorkerEnv.pick({ TELEGRAM_API_ID: true, TELEGRAM_API_HASH: true, TELEGRAM_SESSION_SECRET_REF: true }));
  if (argv.length) {
    console.error('usage: cli telegram-login (no arguments; the session is written to TELEGRAM_SESSION_SECRET_REF, never printed)');
    return 1;
  }
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH || !env.TELEGRAM_SESSION_SECRET_REF) {
    console.error('telegram-login: set TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION_SECRET_REF (path of the session file)');
    return 1;
  }
  // Fail before the interactive login, not after: a login whose session cannot be saved is wasted.
  const target = sessionPath(env.TELEGRAM_SESSION_SECRET_REF);
  if (!(await access(dirname(target), constants.W_OK).then(() => true, () => false))) {
    console.error(`telegram-login: cannot write to the directory of ${target}`);
    return 1;
  }

  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (prompt: string, hidden = false) => {
    if (!hidden) return (await rl.question(prompt)).trim();
    process.stderr.write(prompt);
    muted = true;
    try {
      return await rl.question('');
    } finally {
      muted = false;
      process.stderr.write('\n');
    }
  };

  const client = new TelegramClient(new StringSession(''), Number(env.TELEGRAM_API_ID), env.TELEGRAM_API_HASH, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.ERROR),
  });
  try {
    await client.start({
      phoneNumber: () => ask('Phone number of the service account (international format): '),
      phoneCode: () => ask('Login code from Telegram: '),
      password: (hint) => ask(`2FA password${hint ? ` (hint: ${hint})` : ''}: `, true),
      onError: async (err) => {
        console.error(`telegram-login: ${err.message}`);
        return true; // stop; rerun the command to try again
      },
    });
    const path = await writeSession(env.TELEGRAM_SESSION_SECRET_REF, String(client.session.save()));
    console.error(`telegram-login: session saved to ${path} (mode 0600). Use it in one environment only; restart the worker.`);
    return 0;
  } catch (err) {
    console.error(`telegram-login failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    rl.close();
    await client.destroy().catch(() => {});
  }
}
