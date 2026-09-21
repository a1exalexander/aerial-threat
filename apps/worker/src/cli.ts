// Admin/dev commands: `pnpm --filter @aerial/worker cli <command> [args]`. Each command module owns its logic.
type Command = { run(argv: string[]): Promise<number> };

const commands: Record<string, () => Promise<Command>> = {
  import: () => import('./import/index'),
  replay: () => import('./replay/index'),
  'eval-live': () => import('./eval/index'),
  'mint-dev-token': () => import('./cli/mint-dev-token'),
  'telegram-login': () => import('./cli/telegram-login'),
  'situation-replay': () => import('./situation/replay'),
};

const [name = '', ...args] = process.argv.slice(2);
const load = Object.hasOwn(commands, name) ? commands[name] : undefined;
if (!load) {
  console.error(`usage: cli <${Object.keys(commands).join('|')}> [args]`);
  process.exit(1);
}
process.exitCode = await (await load()).run(args);
