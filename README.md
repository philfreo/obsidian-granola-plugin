# Obsidian Plugin: Granola Meetings Simple Sync

Sync your [Granola](https://granola.ai) meeting notes to Obsidian.

This plugin uses [Granola's official MCP API](https://docs.granola.ai/help-center/sharing/integrations/mcp) to sync meeting notes, AI summaries, and transcripts into your vault. One-time OAuth setup, then fully automatic.

## Features

- **Official API**: Uses Granola's MCP API with OAuth authentication
- **Multiple accounts**: Connect more than one Granola account and sync them all into the same vault
- **Auto-sync**: Automatically sync meetings at configurable intervals (1m to 12h)
- **Template-based**: Customize output format with your own template
- **Smart deduplication**: Tracks meetings by ID to avoid duplicates
- **Preserve edits**: Option to skip existing notes so your local changes aren't overwritten
- **Attendee linking**: Automatically link attendees to existing notes by email
- **Transcripts**: Optionally include full meeting transcripts

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
2. Download `main.js` and `manifest.json` from the [latest release](https://github.com/philfreo/obsidian-granola-plugin/releases) into that folder
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

| Setting | Default | Description |
|---------|---------|-------------|
| Time range | Last 30 days | How far back to look for meetings |
| Sync frequency | Every 15 minutes | How often to sync. Options: Manual only, On startup, 1m, 15m, 30m, 60m, 12h |
| Only my meetings | On | Sync only meetings you recorded or were listed as a participant in, including notes shared with you. Turn off to also sync every workspace-visible meeting |
| Folder path | `Meetings` | Where to save meeting notes. Takes date tokens, so `Meetings/{date:YYYY/MM}` files each meeting under its own month |
| Filename pattern | `{date} {title}` | Pattern for filenames. Supports `{date}`, `{date:YYYY-MM-DD}`, `{title}`, `{id}` |
| Template path | `Templates/Granola.md` | Path to your template file |
| Show ribbon icon | On | Show a sync button in the left sidebar |
| Skip existing notes | On | Don't overwrite notes you've edited. Existing notes are matched by `granola_id` anywhere in your vault, not just the sync folder, so notes you've moved aren't duplicated |
| Granola API key | empty | Optional `grn_…` key enabling meeting length and end time. Create it in the Granola desktop app under Settings > Connectors > API keys; needs a Business or Enterprise plan. Stored unencrypted in your vault |
| Duration format | Compact | How `{{granola_duration_formatted}}` is written: Compact (1h 14m), Long (1 hour 14 minutes), or Minutes only (74 minutes) |
| Include transcripts | Off | Add the full meeting transcript to each note |
| Exclude yourself from attendees | On | Leave your own Granola account out of the attendee list |
| Match attendees by email | On | Link attendees to notes with matching email in frontmatter |

## Usage

1. **Sync meetings**: By default your meetings will be synced every 15 minutes. This setting is customizable, and you can also trigger a sync by clicking the ribbon icon, using the command palette ("Granola Meetings Simple Sync: Sync meetings"), or clicking "Sync now" in settings.

## Template Variables

Create a template file to customize how your meeting notes look. Use these variables:

### Core
- `{{granola_id}}` - Unique meeting ID
- `{{granola_title}}` - Meeting title
- `{{granola_date}}` - Date (YYYY-MM-DD)
- `{{granola_url}}` - Link to meeting on Granola web
- `{{granola_start_time}}` - Start time (e.g., "3:00 PM")

### Timing

- `{{granola_end_time}}` - End time (e.g., "3:35 PM")
- `{{granola_duration_formatted}}` - Length written out (e.g., "1h 14m"), in the style chosen by the "Duration format" setting
- `{{granola_duration_min}}` - The same length as a plain number of minutes (e.g., "74"), for arithmetic

The MCP API Granola gives the plugin reports no end time and no duration, so
**these are blank unless you add a Granola API key** in settings. With a key
the plugin reads the transcript from Granola's REST API instead, where every
utterance carries its own start and end timestamp, and the length is measured
rather than guessed. The key needs a Business or Enterprise plan.

A meeting is measured from the time Granola lists for it rather than from the
first word spoken, so the length covers waiting as well as talking. A call
booked for 2:00 that got going at 2:06 and held thirty minutes of
conversation is reported as thirty-six minutes long. Ad-hoc recordings were
never scheduled, so Granola lists the moment capture began and there is no
waiting to account for. A recording whose first word lands before its listed
time is measured from whichever came first.

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

### Content
- `{{granola_private_notes}}` - Your notes from the meeting
- `{{granola_enhanced_notes}}` - AI-generated content (Summary, Action Items, etc.)
- `{{granola_transcript}}` - Full transcript (requires "Include transcripts" enabled)

### Attendees
- `{{granola_attendees}}` - Comma-separated names
- `{{granola_attendees_linked}}` - With Obsidian links: `[[John]], [[Jane]]`
- `{{granola_attendees_list}}` - YAML list format
- `{{granola_attendees_linked_list}}` - YAML list with links

### Conditional Blocks

Use `{{#variable}}...{{/variable}}` to only render content when a variable is non-empty:

```markdown
{{#granola_transcript}}
## Transcript

{{granola_transcript}}
{{/granola_transcript}}
```

### Default Template

The plugin writes this default template when you first enable it, and again at sync time if no template exists at the configured path:

```markdown
---
granola_id: {{granola_id}}
granola_url: {{granola_url}}
title: "{{granola_title}}"
date: {{granola_date}}
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
{{#granola_transcript}}

## Transcript

{{granola_transcript}}
{{/granola_transcript}}
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

1. Bump the version: `npm version patch` (or `minor`/`major`). This runs `version-bump.mjs`, which updates `manifest.json` and `versions.json`, and stages them in the version commit.
2. Push the commit and the tag: `git push && git push --tags`.
3. The Release workflow runs on the tag and publishes the GitHub release.

Per [Obsidian's guidelines](https://github.com/obsidianmd/obsidian-sample-plugin), tags must **not** use a `v` prefix (use `1.0.0`, not `v1.0.0`) — `npm version` already creates tags without the prefix here, and the workflow only triggers on `[0-9]+.[0-9]+.[0-9]+` tags.

## License

MIT
