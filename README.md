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

The first vertical slice deliberately focuses on reliable dual-channel capture and transcription. Remaining Call.md parity work: recording playback/assembly, bookmarks, live metrics, coaching nudges, meeting preparation, MCP tools, calendar, webhooks, screen-context analysis, and signed/notarized distribution.
