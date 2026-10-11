# pi4normies on Telegram

The same assistant as the codespace, used from a Telegram chat instead. Each
user's job runs in its own throwaway container on your machine, from the same
image (`ghcr.io/bbenligiray/pi4normies`). The container removes itself 24
hours after it starts, unless the user extends it, Mr. Meeseeks style. Each
user pays for their own AI usage with their own OpenRouter key, which you set
up for them.

## What users get

- They message the bot. The first message starts a workspace (about a
  minute), and the assistant answers in the chat.
- **Text, voice and files.** Voice messages are transcribed on the user's
  key, and the bot echoes the transcript so they can check it. Files, photos,
  videos and audio go into the job's `input/` folder, and the assistant is
  told about them. Talklore links work as in the codespace: they just paste
  them.
- **Results come to the chat.** Whenever the assistant finishes a reply, every
  new or changed file in `output/` is sent. More than 8 at once arrive as
  one zip. Files can be up to 2 GB each way.
- **Lifetime.** One hour before the end, the bot sends a warning with a
  "Keep it 24 hours longer" button. At the end it sends any files the user
  hasn't got yet, then deletes the container.
- **Commands:** `/new` (start over), `/status` (time left, model, cost so far),
  `/extend`, `/files` (send every file again), `/stop`, `/done` (finish now),
  `/model [id]`, `/help`. `/new` and `/done` ask for confirmation first.

## Setting it up

You need a Linux machine (amd64, since the image ships Google Chrome) with
Docker and the Compose plugin. Each active job is limited to 2 CPUs and 4 GB
of RAM by default (see `.env.example`), and the image is about 2 GB on disk.

1. **Create the bot.** In Telegram, talk to [@BotFather](https://t.me/BotFather):
   `/newbot`, pick a name and a username, and copy the **token** it gives you.
2. **Get an API ID and hash** at https://my.telegram.org/apps. Log in with
   your phone number and create an app; the name doesn't matter. The bot uses
   Telegram's own [Bot API server](https://github.com/tdlib/telegram-bot-api)
   running locally, and that's what lifts the file size limits from
   20 MB (down) and 50 MB (up) to 2 GB. The server needs these values.
3. **Configure:**
   ```bash
   git clone https://github.com/bbenligiray/pi4normies
   cd pi4normies/telegram
   cp .env.example .env                           # fill in the three values
   cp config/users.example.json config/users.json # see "Adding users"
   ```
4. **Start:**
   ```bash
   docker compose up -d --build
   docker compose logs -f bot
   ```
   On first start the bot logs itself out of Telegram's cloud Bot API, which
   the local server requires. It does this once and remembers it. After that,
   the token only works through the local server. To move the bot back to
   the cloud, call `logOut` on the local server and set
   `TELEGRAM_CLOUD_LOGOUT=0`.

## Adding users

The allowlist is `config/users.json`: Telegram user IDs, each with that
user's OpenRouter key:

```json
{
  "123456789": { "name": "Alice", "openrouterKey": "sk-or-v1-..." }
}
```

- **Finding someone's user ID:** have them message the bot. Anyone who isn't
  on the list gets a reply with their ID ("Your Telegram user ID is …") to
  send you. Alternatively, they can message
  [@userinfobot](https://t.me/userinfobot), which replies with it.
- **Their key:** create one at https://openrouter.ai/settings/keys on their
  OpenRouter account, ideally with a credit limit.
- Edits apply right away, without a restart. A changed key applies from the
  user's next job; the running one keeps the key it started with. `name` is
  only for you.

## Running it

- **Logs:** `docker compose logs -f bot`.
- **Running jobs:** `docker ps --filter label=pi4normies.job=1`. Each container
  is named `pi4normies-<user id>-…`.
- **Updating the bot:** `git pull && docker compose up -d --build`. Running
  jobs aren't touched. The bot reattaches to them when it starts, and that
  includes after a reboot: job containers restart with Docker.
- **Updating the assistant:** nothing to do. The bot pulls
  `ghcr.io/bbenligiray/pi4normies:latest` (rebuilt daily) each time a job
  starts, prunes the image it replaced, and `post-create` updates pi inside
  the container as in a codespace.
- **State** is `/data/state.json` in the `bot-data` volume: which container
  belongs to whom, and when it expires. Containers the bot doesn't know about
  are removed when it starts.
- **Removing everything:**
  `docker compose down -v && docker rm -f $(docker ps -aq --filter label=pi4normies.job=1) && docker network rm pi4normies-jobs`.

## How it works

- `src/main.ts` starts everything. `src/bot.ts` holds the Telegram handlers.
  Updates are processed one at a time per chat, so a file and the message
  sent after it reach the assistant in order.
- `src/jobs.ts` manages a job's lifecycle and links pi to the chat.
  - Each job's container runs `pi-telegram` (`scripts/pi-telegram` in the
    image): pi in [RPC mode](https://pi.dev) on the container's
    stdin/stdout, which the bot attaches to.
  - pi's answers are rendered from Markdown to Telegram's HTML subset
    (`src/render.ts`).
  - pi's extension dialogs (confirm, select, input) become buttons or
    questions.
  - `pi-telegram` installs `config/AGENTS.telegram.md` as the agent's
    standing instructions, in place of the codespace version.
- `src/docker.ts` handles the containers. Files move in and out through the
  Docker API, never through host paths. If pi dies or the machine reboots,
  the container restarts and pi continues the same conversation
  (`pi --continue`). If a reply was cut short, the user is asked to send
  their last message again.

## Security notes

- The bot has the Docker socket, which is root on the machine. Use a
  machine that does nothing else.
- Job containers run the agent with passwordless sudo and full internet
  access, as in a codespace. They share a bridge network
  (`pi4normies-jobs`) on which they can't reach each other or the bot. They
  can still reach the host's own open ports, so keep the host firewalled.
- On a cloud VM, block the metadata endpoint from containers, or an agent
  could read the VM's credentials:
  `iptables -I DOCKER-USER -d 169.254.169.254 -j DROP` (and make it
  persistent).
- Each user's key is visible in `docker inspect` of their container, and to
  the agent itself, as in a codespace. Credit limits on the keys cap the
  damage.
- Container disk usage isn't capped. Docker's default storage driver can't
  do it, and jobs are short-lived.

## Development

```bash
npm ci
npm run check   # types
npm test        # everything below except the live test; no Docker, Telegram or AI key needed
OPENROUTER_API_KEY=sk-or-... npm run test:live   # real pi and AI calls, a few cents
```

The tests, in `test/`:

- `render.test.ts`: Markdown to Telegram HTML, and splitting long answers.
- `rpc.test.ts`: the RPC client's framing, request matching and close.
- `e2e.test.ts`: the whole bot, run as a process against a fake Telegram
  Bot API server (`fake-telegram.ts`) and a scripted pi (`fake-pi.ts`). It
  covers messages, files both ways, voice, dialogs, errors, commands, bot
  restarts, pi crashes, expiry with the extend button, and `/done`. It runs
  twice: once with the local runtime, and once with the Docker runtime
  against a fake Docker Engine API (`fake-docker.ts`). That fake hands any
  attach request body to pi's stdin, as Docker may, and takes over the
  connection right after the headers, as Docker's Go server does.
- `docker.test.ts`: the Docker runtime on its own, against the fake: attach
  and reattach, exec, files in and out, list and remove.
- `pi-contract.test.ts`: what the bot relies on from the real `pi` (skipped
  if it isn't installed). It checks that `--continue` works with no session
  yet, that stray input lines are rejected without losing the next command,
  and that `scripts/pi-telegram` leaves stdout to pi alone.
- `live.ts` (`npm run test:live`): real pi on a cheap model (`LIVE_MODEL`),
  checking for an answer, a file it writes, real transcription of
  `fixtures/voice.oga`, and the cost in `/status`.

`RUNTIME=local` runs jobs as plain `pi` processes in `DATA_DIR/local-jobs`
instead of containers, with no isolation. It's useful for trying the bot on
a Linux laptop (it lists `output/` with GNU `find`): point
`TELEGRAM_API_ROOT` at `https://api.telegram.org` (2 GB files need the local
server), and set `TELEGRAM_CLOUD_LOGOUT=0`, `DATA_DIR=./data` and
`USERS_FILE=./config/users.json`.
