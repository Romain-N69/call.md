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
- Persistent summaries, key points, action items, and automatic local `meeting.md` files
- Personal live notes merged into the final summary
- Timestamp-cited questions and catch-up answers during and after meetings
- Resident menu-bar controls, optional launch at login, and notes-ready notifications
- Consent-based Zoom, Teams, Slack, FaceTime, WhatsApp, Discord, and browser-call detection
- Automatic finalization after the detected meeting application releases the microphone
- Local meeting history and recording folders
- Synapse key encrypted in macOS Keychain via Electron `safeStorage`
- Voice writing workspace with live dictation and a final high-accuracy pass
- Separate verbatim and polished versions so the source is always preserved
- Grammar correction, six output formats, six tones, three rewrite strengths, and optional style examples
- 30+ spoken languages, output translation, copy, Markdown/text export, and local writing history

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
