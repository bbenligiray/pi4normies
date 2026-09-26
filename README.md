# pi4normies

An AI assistant ([pi](https://pi.dev)) in your browser, ready to take on a
task for you: research, writing, documents, images, video, small websites,
and so on. Nothing to install; it runs in a
[GitHub Codespace](https://github.com/features/codespaces), works on any
computer, and is thrown away when you're done.

## Before your first job (once)

1. **GitHub account.** Sign up at https://github.com/signup if you don't have
   one.
2. **OpenRouter key.** OpenRouter pays for the assistant's AI usage.
   - Sign up at https://openrouter.ai and add some credit
     (https://openrouter.ai/settings/credits).
   - Create a key at https://openrouter.ai/settings/keys. Setting a credit
     limit on it is a good idea. Copy the key.
3. **Give the key to GitHub.** Go to https://github.com/settings/codespaces,
   and under **Codespaces secrets** click **New secret**:
   - Name: `OPENROUTER_API_KEY`
   - Value: the key you copied
   - Repository access: `bbenligiray/pi4normies`

## Doing a job

1. Open **https://codespaces.new/bbenligiray/pi4normies** and click
   **Create codespace**. Give it a minute or two to start.
2. The assistant opens at the bottom of the screen. Type what you need and
   press Enter. It will ask questions if it needs more detail.
3. **Giving it files:** drag them from your computer onto the `input` folder
   in the left sidebar, or just paste a link (Google Drive, Dropbox, ...) into
   the chat.
4. **Getting results:** they appear in the `output` folder in the left
   sidebar. Right-click a file and choose **Download**.
5. **When you're done**, download everything you need from `output`, then
   delete the codespace at https://github.com/codespaces (**...** next to it >
   **Delete**). Deleted codespaces can't be recovered.

Tips:
- If you close the assistant by accident, press Enter in its panel to start it
  again.
- To use a different AI model, type `/model` in the assistant.
- An unused codespace stops by itself after a while; reopen it from
  https://github.com/codespaces and your files will still be there. Stopped
  codespaces are deleted automatically after some time (30 days by default).
- GitHub gives every account free Codespaces hours each month, which is
  plenty for occasional jobs. See https://github.com/settings/billing.

---

## Maintainer notes

- **Image:** `.github/workflows/image.yml` builds the `Dockerfile` and pushes
  `ghcr.io/bbenligiray/pi4normies:latest` on changes to `main`, daily, and on
  manual dispatch, after a smoke test (pi starts with both extensions and the
  default model). After the first push, make the package **public**
  (github.com/users/bbenligiray/packages/container/pi4normies/settings), or
  codespaces can't pull it.
- **Latest pi:** besides the daily build, `scripts/post-create` updates pi on
  every codespace creation, since GitHub disables schedules after 60 days of
  repo inactivity.
- **pi config** baked into the image: `config/settings.json` (OpenRouter,
  `anthropic/claude-opus-5.5`, bundled extensions) and `config/AGENTS.md`
  (instructions for working with non-technical users). Both are user-level,
  in `~/.pi/agent/`.
- **Extensions** (`extensions/`): `browser` (`browser_screenshot`,
  `browser_dom` via headless Chrome) and `websearch` (`web_search` via
  Perplexity on OpenRouter; model override with `PI_WEBSEARCH_MODEL`).
- **Codespace UX** (`.devcontainer/devcontainer.json`, `.vscode/tasks.json`):
  the assistant auto-starts in a terminal (`scripts/pi-start`, which explains
  how to add the key if it's missing), and the sidebar hides everything but
  `input/` and `output/`.
- **Billing:** the repo is on a personal account, so each user's Codespaces
  usage goes to their own GitHub account (free monthly quota first), and AI
  usage to their own OpenRouter key.
