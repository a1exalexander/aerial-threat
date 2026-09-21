# @aerial/test-fixtures

Only **redacted, synthetic or minimised** fixtures go here: no full Telegram exports (`result.json` is gitignored everywhere), no phone numbers, bank card or jar links, personal names, or session data. The repository is public.

Each fixture needs a manifest entry with its origin (for example "redacted from channel X, message IDs …"), its content hash, and the regression case it covers.

## Telegram exports

`telegram/energy.json` and `telegram/kremenchuk.json` are Telegram Desktop `result.json` subsets. Every record with an ID in 13745–13810 (Energy) or 101889–101903 (Кременчук) is kept. The reply chains stay inside those ranges. Energy 13790 replies to 13789, which the original export does not contain either, so it covers `missing_context`. IDs, `date_unixtime`/`edited_unixtime`, replies, media metadata and reactions are unchanged. Text is changed only by redaction:

- `bank_card`, `phone` and `email` entities, card numbers and phone numbers become `[КАРТКА]`, `[ТЕЛЕФОН]` and `[EMAIL]`.
- Payment links become `https://pay.example.invalid/redacted`.
- Private persons (donor names) become `[ІМЕНА]`. Public officials quoted in news stay.

`telegram/kremenchuk-mykolai.json` is a 38-record subset of the Кременчуцький Миколай export (bare ID `2432204405`, no known username). It holds the IDs in 23997–23999, 24065–24075, 24086–24099, 24110–24118 and 24130–24135. The posts are informal and mix Ukrainian and Russian. They cover:

- slang threat posts («реактивный мопед», «бандероли», «Бублистика»);
- route lists with Russian spellings;
- forecasts («буде відбій», «Щас будет тревога»);
- «Упав» and «По ним минус» reply chains;
- an ad, a job post, a donation request, jokes and complaints;
- a sticker with empty text, a voice message and a forwarded post.

24096 replies to 23886, which is missing from the original export, so it covers `missing_context`. This file uses look-alike placeholders, so rules that match payment details still fire:

- Card numbers become `0000 0000 0000 0001` (Luhn-invalid).
- Jar links become `https://send.monobank.ua/jar/REDACTED`.
- Phones become `+380 00 000 00 00` and emails become `[EMAIL]`.
- The forward sender becomes `[ІМ'Я]` and contact names are removed.
- Two profanity-heavy complaints are paraphrased neutrally.

`manifest.json` lists every record with the sha256 of `JSON.stringify(record)`, its reply target and, where one applies, the doc 09 regression case. `labels.template.json` has one all-`null` label row per record (kind, temporal scope, threat type, places, numbers, ambiguity, reply, origin group, expected publication). Labelers copy the template and fill it in. `null` means "not labelled yet".

```ts
import { loadTelegramExport, manifest, telegramExportPath } from '@aerial/test-fixtures';
parseTelegramExport(loadTelegramExport('energy')); // from @aerial/telegram/export
```

```sh
pnpm --filter @aerial/worker cli import --file packages/test-fixtures/telegram/energy.json --username ppo_energy_poltava
```

The unit test fails if a record drifts from its manifest hash, or if a card number, phone number or payment link other than the placeholders above appears. After you edit a fixture, regenerate the hashes and review the diff for personal data.
