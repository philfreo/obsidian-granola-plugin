# Obsidian Plugin: Granola Meetings Simple Sync

Sync your [Granola](https://granola.ai) meeting notes to Obsidian.

This plugin uses [Granola's official MCP API](https://docs.granola.ai/help-center/sharing/integrations/mcp) to sync meeting notes, AI summaries, and transcripts into your vault. One-time OAuth setup, then fully automatic.

## Features

- **Official API**: Uses Granola's MCP API with OAuth authentication
- **Multiple accounts**: Connect more than one Granola account and sync them all into the same vault
- **Auto-sync**: Automatically sync meetings at configurable intervals (1m to 12h)
- **Local JSON Cache**: Stores raw meeting metadata and transcripts in separate files (`cache/meetings/` and `cache/transcripts/`), protecting against data loss and rate limits
- **Instant Re-rendering**: Re-render all your notes and transcripts in under a second when templates or folder routing change, without making any network calls
- **Standalone Transcripts**: Decouples full transcripts into separate documents (`type: transcript`) bidirectionally linked with meeting notes (`type: meeting`), keeping notes lightweight and preventing transcript API calls from blocking note creation
- **Live Progress & Interruption**: Real-time sync progress with item counts, transcript pacing countdown, status bar indicator, and a "Stop sync" button
- **Custom Path Routing**: Route notes and transcripts using `{granolaFolder}`, `{meeting_date}`, `{meeting_name}`, and `{id}`. Transcripts can be saved side-by-side or in custom subfolders
- **Rate Limit Protection**: Built-in 65-second spacing between transcript downloads with reactive exponential backoff on HTTP 429
- **Template-based**: Customize output format with separate templates for meeting notes and transcripts
- **Smart deduplication**: Tracks meetings by ID to avoid duplicates
- **Preserve edits**: Option to skip existing notes so your local changes aren't overwritten
- **Attendee linking**: Automatically link attendees to existing notes by email

There are other ([1](https://github.com/dannymcc/Granola-to-Obsidian), [2](https://github.com/tomelliot/obsidian-granola-sync)) Granola plugins for Obsidian, but I found their implementation lacking for my needs. They either had unnecessary complexity or didn't support features like bringing in private notes, linking to attendee Person notes, or customizing the note template/frontmatter. This plugin fits my workflow better.

## Installation

### Install from the Obsidian Directory (recommended)

Click "Add to Obsidian" from https://community.obsidian.md/plugins/granola-meetings-simple-sync

### Install via BRAT
1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's community plugins
2. In BRAT settings, click **Add Beta plugin**
3. Enter `philfreo/obsidian-granola-plugin`
4. Enable the plugin in Settings → Community plugins

BRAT will automatically keep the plugin updated.

### Manual Installation
1. Create a folder `<vault>/.obsidian/plugins/granola-meetings-simple-sync/`
2. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/philfreo/obsidian-granola-plugin/releases) into that folder
3. Reload Obsidian, then enable the plugin in Settings → Community plugins

## Setup

1. Open plugin settings
2. Click **Connect to Granola** — this opens your browser for OAuth authentication
3. Authorize the plugin in your browser
4. You'll be redirected back to Obsidian automatically
5. Meetings will start syncing!

To sync more than one Granola account, click **Add Granola account** in settings and repeat the OAuth flow. All connected accounts sync into the same folder, deduplicated by meeting ID.

## Settings

![Settings screenshot](docs/options-screenshot.png)

### Sync & Cache Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Time range | Last 30 days | How far back to look for meetings. Options: This week, Last week, Last 30 days, Last 90 days, Last 180 days, Last 1 year, All time. (Note: Granola Free plans restrict history to 30 days) |
| Sync frequency | Every 15 minutes | How often to sync. Options: Manual only, On startup, 1m, 15m, 30m, 60m, 12h |
| Only my meetings | On | Sync only meetings you recorded or were listed as a participant in, including notes shared with you. Turn off to also sync every workspace-visible meeting |
| Granola API key | empty | Optional `grn_…` key enabling meeting length and end time. Create it in the Granola desktop app under Settings > Connectors > API keys; needs a Business or Enterprise plan. Stored unencrypted in your vault |
| Show ribbon icon | On | Show a sync button in the left sidebar |
| Refresh summaries | — | Button to query Granola for updated summaries and refresh the cache/notes without touching transcripts |
| Re-render notes from cache | — | Button to instantly regenerate all vault notes from local disk cache using current templates and folder patterns without contacting Granola |
| Clear local cache | — | Button to purge the local raw JSON cache |

### Notes & Routing Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Folder path | `Meetings` | Where to save meeting notes. Supports `{granolaFolder}` / `{folder}`, `{meeting_date}` / `{date}`, `{date:YYYY/MM}`, `{meeting_name}` / `{title}`, `{id}` |
| Filename pattern | `{date} {title}` | Pattern for meeting note filenames. Supports `{date}`, `{date:YYYY-MM-DD}`, `{title}`, `{id}`, `{granolaFolder}` |
| Template path | `Templates/Granola.md` | Path to your meeting note template file |
| Duration format | Compact | How `{{granola_duration_formatted}}` is written: Compact (1h 14m), Long (1 hour 14 minutes), or Minutes only (74 minutes) |
| Update note content on sync | On | Re-renders existing vault notes with fresh content from Granola. Disable to preserve manual edits |
| Re-route notes on sync | Off | Move/rename existing notes if the folder or filename pattern changes |

### Transcript Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Sync transcripts | Off | Download full transcripts as standalone documents. Transcripts are fetched in Phase 2 with a 65s pacing delay between calls to comply with Granola rate limits |
| Transcript folder | `{meeting_folder}` | Where to save transcript documents. Defaults to the same folder as the meeting note. Supports `{meeting_folder}`, `{meeting_filename}`, `{granolaFolder}`, `{date}`, `{title}`, `{id}` |
| Transcript filename pattern | `{filename} (Transcript)` | Pattern for transcript filenames. Supports `{meeting_filename}` / `{filename}`, `{meeting_folder}`, `{date}`, `{title}`, `{id}`, `{granolaFolder}` |
| Transcript template path | `Templates/Granola Transcript.md` | Path to your transcript document template file |
| Update transcript content | On | Re-renders existing transcripts on sync |
| Re-route transcripts | Off | Move/rename existing transcripts if pattern changes |

### Attendees Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Exclude yourself from attendees | On | Leave your own Granola account out of the attendee list |
| Match attendees by email | On | Link attendees to notes with matching email in frontmatter |

## Usage & Live Progress

1. **Triggering a sync**: By default your meetings sync automatically at your chosen frequency. You can also manually trigger a sync by clicking the ribbon icon, running the "Sync meetings" command from the palette, or clicking "Sync now" in plugin settings.
2. **Real-time Progress & Status Bar**: During a sync, the settings page displays an active progress bar with step-by-step status messages (e.g. `Syncing meetings (3/15)...`, `Next transcript in 42s (2/5)...`). The Obsidian status bar also displays live sync counts and countdowns.
3. **Interrupting a Sync**: If you need to stop a long-running sync (such as when downloading many transcripts), click the **Stop sync** button in settings. The plugin gracefully aborts network requests and stops the pacing loop immediately. All meetings and transcripts downloaded up to that point are safely preserved in the local cache.
4. **Re-rendering from Cache**: Whenever you tweak your template, change frontmatter fields, or update your folder routing, you don't need to make any network calls or risk hitting API rate limits. Click **Re-render notes** in settings (or run "Granola Meetings Simple Sync: Re-render notes from cache" from the command palette). All notes and transcripts regenerate in milliseconds from local disk cache!

## Two-Stage Architecture & Decoupled Transcripts

The plugin operates on a robust two-stage pipeline:

```
[Granola MCP API]
       │
       ▼ (Stage 1: Fetch & Cache — Network, rate-limited & paced)
[Local JSON Cache (.obsidian/plugins/.../cache/)]
   ├── meetings/<meeting-id>.json
   └── transcripts/<meeting-id>.json
       │
       ▼ (Stage 2: Render & Route — Pure local computation, < 1s)
[Vault Markdown Notes & Transcripts (.md)]
```

- **Separated Cache Storage**: Meeting metadata and full transcripts are cached in separate JSON files under `<vault>/.obsidian/plugins/granola-meetings-simple-sync/cache/`. Because this directory is inside `.obsidian/`, it is completely invisible to vault search, backlinks, and graph views.
- **Resumable Transcripts**: If a sync is stopped partway through downloading transcripts, downloaded transcripts are already cached on disk. The next sync resumes immediately without re-fetching existing transcripts.
- **Two-Document Model**: Meeting notes (`type: meeting`) and transcripts (`type: transcript`) are saved as independent markdown files connected bidirectionally via frontmatter properties `meeting_transcript` and `meeting_note`.

### Available Variables

#### Core Variables
- `{{granola_id}}` - Unique meeting ID
- `{{granola_title}}` - Meeting title
- `{{granola_date}}` - Date (YYYY-MM-DD)
- `{{granola_url}}` - Link to meeting on Granola web
### Timing
- `{{granola_start_time}}` - Start time (e.g., "3:00 PM")
- `{{granola_end_time}}` - End time (e.g., "3:35 PM")
- `{{granola_duration_formatted}}` - Length written out (e.g., "1h 14m"), in the style chosen by the "Duration format" setting
- `{{granola_duration_min}}` - The same length as a plain number of minutes (e.g., "74"), for arithmetic

The MCP API Granola gives the plugin reports no end time and no duration, so
**these are blank unless you add a Granola API key** in settings. With a key
the plugin reads the transcript from Granola's REST API instead, where every
utterance carries its own start and end timestamp, and the length is measured
rather than guessed. The key needs a Business or Enterprise plan.

Both times are rendered in your own locale, following the language Obsidian
is set to, so a 24-hour locale gets "14:06" where an English one gets
"2:06 PM".

#### Duration format

`{{granola_duration_formatted}}` is written in one of three styles, chosen
in settings. Unit names follow the language Obsidian is set to, so a German
reader gets "1 Std. 14 Min." without configuring anything.

| Setting | 35 min | 60 min | 74 min |
|---------|--------|--------|--------|
| Compact (default) | 35m | 1h | 1h 14m |
| Long | 35 minutes | 1 hour | 1 hour 14 minutes |
| Minutes only | 35 minutes | 60 minutes | 74 minutes |

A component is left out when it would read as zero, so an hour-long meeting
is "1h" rather than "1h 0m". Hours are not capped at a day.

For any wording the three styles don't cover, build your own from
`{{granola_duration_min}}`, which is a plain number of minutes.

#### Folder & Collection Variables
- `{{granola_folder}}` (aliases: `{{granolaFolder}}`, `{{folder}}`) - Primary folder name
- `{{granola_folders}}` - Comma-separated list of all folders
- `{{granola_folders_linked}}` - With Obsidian links: `[[Client Acme]], [[Q3 Launch]]`
- `{{granola_folders_list}}` - YAML list format
- `{{granola_folders_linked_list}}` - YAML list with links:
  ```yaml
  folders:
  {{granola_folders_linked_list}}
  ```

#### Bidirectional Linking Variables
- `{{granola_meeting_transcript}}` - The filename/title of the linked transcript document (for use in meeting note templates)
- `{{granola_meeting_note}}` - The filename/title of the linked meeting note (for use in transcript templates)

#### Content Variables
- `{{granola_private_notes}}` - Your notes from the meeting
- `{{granola_enhanced_notes}}` - AI-generated content (Summary, Action Items, etc.)
- `{{granola_transcript}}` - Full transcript text (for transcript templates)

#### Attendees
- `{{granola_attendees}}` - Comma-separated names
- `{{granola_attendees_linked}}` - With Obsidian links: `[[John]], [[Jane]]`
- `{{granola_attendees_list}}` - YAML list format
- `{{granola_attendees_linked_list}}` - YAML list with links

### Conditional Blocks

Use `{{#variable}}...{{/variable}}` to render content only when a variable is non-empty.

### Default Meeting Template (`Templates/Granola.md`)

```markdown
---
granola_id: {{granola_id}}
granola_url: {{granola_url}}
title: "{{granola_title}}"
date: {{granola_date}}
type: meeting
{{#granola_meeting_transcript}}
meeting_transcript: "[[{{granola_meeting_transcript}}]]"
{{/granola_meeting_transcript}}
{{#granola_folders}}
folders:
{{granola_folders_linked_list}}
{{/granola_folders}}
attendees:
{{granola_attendees_linked_list}}
tags:
  - meeting
  - granola
---
{{#granola_private_notes}}## Notes

{{granola_private_notes}}
{{/granola_private_notes}}
{{#granola_enhanced_notes}}## Summary

{{#granola_duration_formatted}}{{granola_start_time}}-{{granola_end_time}} ({{granola_duration_formatted}})

{{/granola_duration_formatted}}{{granola_enhanced_notes}}
{{/granola_enhanced_notes}}
```

### Default Transcript Template (`Templates/Granola Transcript.md`)

```markdown
---
granola_id: {{granola_id}}
granola_url: {{granola_url}}
title: "{{granola_title}} (Transcript)"
date: {{granola_date}}
type: transcript
{{#granola_meeting_note}}
meeting_note: "[[{{granola_meeting_note}}]]"
{{/granola_meeting_note}}
{{#granola_folders}}
folders:
{{granola_folders_linked_list}}
{{/granola_folders}}
tags:
  - transcript
  - granola
---
## Transcript

{{granola_transcript}}
```

## Requirements

- **Desktop only**: This plugin requires Node.js APIs available only in Obsidian's desktop app
- **Granola account**: You'll be prompted to authenticate via OAuth on first use

## Development

```bash
npm install
npm run dev        # Build (watch mode)
npm run build      # Build (production)
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm test           # Run unit tests (Vitest) once
npm run test:watch # Run unit tests in watch mode
npm run package    # Build + copy main.js/manifest.json/versions.json into release/
```

### Testing in a real vault

Unit tests cover the parser and template logic, but to exercise the plugin inside Obsidian:

1. Copy `.env.example` to `.env` and set `OBSIDIAN_PLUGINS` to the `plugins` folder of the vault you want to test against, e.g.:
   ```
   OBSIDIAN_PLUGINS="$HOME/path/to/YourVault/.obsidian/plugins"
   ```
2. Run `npm run deploy-local`. This builds the plugin and copies it into `$OBSIDIAN_PLUGINS/granola-meetings-simple-sync/`, preserving any existing `data.json` (your settings/auth) so you don't have to reconnect each time.
3. In Obsidian, reload (or toggle the plugin off/on) to pick up the new build.

### Releasing

Releases are automated by `.github/workflows/release.yml`: pushing a tag of the form `X.Y.Z` builds the plugin and creates a GitHub release with `main.js` and `manifest.json` attached. BRAT and manual installs pull from that release.

To cut a release:

1. Bump the version: `npm version patch` (or `minor`/`major`). This first runs `preversion` (lint, typecheck, tests, build) and aborts without committing or tagging if anything fails, so a release cannot be cut from a broken tree. It then runs `version-bump.mjs`, which updates `manifest.json` and `versions.json`, and stages them in the version commit.
2. Push the commit and the tag: `git push && git push --tags`.
3. The Release workflow runs on the tag and publishes the GitHub release.

Per [Obsidian's guidelines](https://github.com/obsidianmd/obsidian-sample-plugin), tags must **not** use a `v` prefix (use `1.0.0`, not `v1.0.0`) — `npm version` already creates tags without the prefix here, and the workflow only triggers on `[0-9]+.[0-9]+.[0-9]+` tags.

## License

MIT
