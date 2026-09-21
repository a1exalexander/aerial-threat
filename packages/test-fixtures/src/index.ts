// Redacted Telegram Desktop export subsets for tests (server/test code only: reads files with node:fs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type TelegramFixture = 'energy' | 'kremenchuk' | 'kremenchuk-mykolai';

export type Manifest = {
  version: number;
  files: Record<
    TelegramFixture,
    {
      path: string;
      channel: string;
      /** null: the channel's public username is not known yet. */
      username: string | null;
      sourceExternalId: string;
      records: Array<{ id: string; sha256: string; replyTo?: string; case?: string }>;
    }
  >;
};

const file = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const json = (rel: string): unknown => JSON.parse(readFileSync(file(rel), 'utf8'));

export const manifest = json('manifest.json') as Manifest;

/** Absolute path of a fixture export, e.g. for `cli import --file`. */
export const telegramExportPath = (name: TelegramFixture) => file(manifest.files[name].path);

/** A fresh parse of a fixture export in Telegram Desktop `result.json` format. */
export const loadTelegramExport = (name: TelegramFixture): unknown => json(manifest.files[name].path);

/** Blank labelling template (every label null) for the fixture records; see doc 09. */
export const loadLabelsTemplate = (): unknown => json('labels.template.json');
