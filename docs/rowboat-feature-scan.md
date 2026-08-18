# Rowboat feature scan

Source reviewed: Rowboat commit [`81d8021`](https://github.com/rowboatlabs/rowboat/tree/81d8021391680a13033d0bf9d58a3f660d16f907), 18 August 2026.

## Relevant features adopted

- **Resident menu-bar app and recording control.** Rowboat keeps a tray presence and exposes meeting start/stop there ([source](https://github.com/rowboatlabs/rowboat/blob/81d8021391680a13033d0bf9d58a3f660d16f907/apps/x/apps/main/src/tray.ts)). Synapse Call Local now does the same and can optionally open at login.
- **Consent-based ambient meeting detection.** Rowboat observes microphone ownership, identifies common meeting apps, and prompts rather than auto-recording ([detector](https://github.com/rowboatlabs/rowboat/blob/81d8021391680a13033d0bf9d58a3f660d16f907/apps/x/packages/core/src/meetings/detector.ts), [native monitor](https://github.com/rowboatlabs/rowboat/blob/81d8021391680a13033d0bf9d58a3f660d16f907/apps/x/apps/main/native/mic-monitor.swift)). Synapse Call Local now uses its own compact CoreAudio monitor and native notification; it never reads microphone content during detection.
- **Call-end and notes-ready flow.** Rowboat watches the external meeting process and notifies when generated notes are ready ([meeting implementation notes](https://github.com/rowboatlabs/rowboat/blob/81d8021391680a13033d0bf9d58a3f660d16f907/apps/x/GRANOLA_PARITY.md)). Synapse Call Local now finalizes after the meeting app releases the microphone and posts a clickable completion notification when in the background.
- **User notes plus transcript.** Rowboat's meeting enhancement combines raw notes and transcript, and its meeting surface supports contextual questions ([meeting implementation notes](https://github.com/rowboatlabs/rowboat/blob/81d8021391680a13033d0bf9d58a3f660d16f907/apps/x/GRANOLA_PARITY.md)). Synapse Call Local now persists notes during recording, includes them in summarization, and supports timestamp-cited questions during and after a meeting.
- **Inspectable local Markdown.** Rowboat stores meeting knowledge as local Markdown ([README](https://github.com/rowboatlabs/rowboat/blob/81d8021391680a13033d0bf9d58a3f660d16f907/README.md)). Every Synapse Call Local meeting now maintains `meeting.md` beside its source media.

## Deliberately not copied

Email, browser, code agents, mini-apps, general MCP integrations, and the global knowledge graph are Rowboat's general coworker product, not meeting-recorder features. Calendar OAuth and pre-meeting briefs remain separate integrations because adding fake or partial connectors would not be useful.
