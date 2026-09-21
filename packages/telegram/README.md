# @aerial/telegram

- `@aerial/telegram/export` parses a Telegram Desktop channel export (`result.json`) into archive `NormalizedMessage`s. The worker's `cli import` uses it.
- `@aerial/telegram/live` is the GramJS source behind the worker's `telegram` loop (the live collector).

## Channels and configuration

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `TELEGRAM_CHANNELS` | worker | `ppo_energy_poltava,h_kremenchug` | Live collector allowlist: public usernames, comma list. |
| `KREMENCHUK_SOURCES` | api, worker | `h_kremenchug,2432204405` | Sources that feed the Kremenchuk screen and its AI window: usernames or bare channel IDs, comma list. |

The two lists are independent. ППО Energy Полтава (`ppo_energy_poltava`) is still collected, but it is not in `KREMENCHUK_SOURCES`, so the Kremenchuk view leaves it out.

A source is identified by its **bare channel ID** (`sources.external_id`, for example `2432204405`), never by `-100…` or `channel…`. The importer and the live collector both key on it, so imported history and live posts land on the same `sources` row and the same messages.

| Channel | Username | Bare ID |
| --- | --- | --- |
| ППО - Energy Полтава⚡️ | `ppo_energy_poltava` | `1706408894` |
| Х Кременчук | `h_kremenchug` | `1483795331` |
| Кременчуцький Миколай | not known yet | `2432204405` |

## Importing an export

```sh
pnpm --filter @aerial/worker cli import --file "<path>/result.json" [--username <channel username>]
```

- **Idempotent.** A rerun of the same file reports `imported=0` and enqueues no new jobs. `imported + unchanged + invalid + unsupported = total`.
- **Display name.** The source's `display_name` comes from the export's `name`. `--username` sets `username`. Both fill blanks only, so values that the live collector or an operator already set are kept.
- **Record shapes:**
  - Service records (pins and similar) are `unsupported`.
  - A malformed record is `invalid` and quarantined.
  - Stickers, voice messages and album parts without a caption are imported with empty text and counted as `mediaOnly`.
  - A forwarded post is imported as the channel's own post. `forwarded_from` stays in the raw payload.
  - Custom emoji keep their text in place.
- **Missing parents.** A reply whose parent is in neither the file nor an earlier import is reported as `missingContext`. The parent is never invented.

## Кременчуцький Миколай

The export has no public username, so import it without `--username`. The source then has `display_name` «Кременчуцький Миколай», `external_id` `2432204405` and no username. Post links stay `null` until the username is known.

To connect the channel live once its username is known:

1. Add the username to `TELEGRAM_CHANNELS`, for example `TELEGRAM_CHANNELS=ppo_energy_poltava,h_kremenchug,<username>`.
2. Keep `2432204405` in `KREMENCHUK_SOURCES`. The username works there too.
3. Run the collector (restart the worker). It resolves the username to the bare ID `2432204405` and updates that same `sources` row. It sets `username`, refreshes `display_name` from the Telegram title, and backfills about 24 h. From then on posts get links, and imported history and live posts merge.
