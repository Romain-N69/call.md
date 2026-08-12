# Synapse Call Local

A local-first macOS meeting recorder rebuilt from the Call.md product model without VideoDB.

## Current capabilities

- Electron macOS application
- Separate microphone (`You`) and system-audio (`Them`) capture
- Native macOS microphone and Screen Recording permissions
- Local segmented WebM recordings
- Per-channel transcription through Thales Synapse (`whisper-1@v2-large`)
- Combined chronological transcript in local SQLite
- Post-meeting summary, key points, and actions through Synapse (`gpt-4o@2024-11-20`)
- Local meeting library with full-text search, favorites, notes, and deletion
- Live talk ratio, WPM, question count, long-turn coaching, and bookmarks
- Persistent summaries, key points, action items, and Markdown export
- Local meeting history and recording folders
- Synapse key encrypted in macOS Keychain via Electron `safeStorage`

No VideoDB API, SDK, binary, account, or key is used.

## Run

```bash
npm install
npm run dev
```

You can either export `THALES_SYNAPSE_SYNAPSE_LLM_KEY` before launch or save it from the application. Grant Microphone and Screen Recording permissions when prompted.

## Build a macOS DMG

```bash
npm run dist:mac
```

## Next slices

Remaining integrations require their own credentials or platform setup: Google Calendar, MCP servers, workflow webhooks, screen-context analysis, recording assembly/playback, and Apple Developer ID signing/notarization.
