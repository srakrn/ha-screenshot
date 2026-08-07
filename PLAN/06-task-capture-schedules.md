# Task-level capture schedules plan

## Status

Proposed implementation plan. This document does not describe shipped functionality.

## Goal

Avoid unnecessary Chromium work by limiting captures to useful time windows and optionally refreshing a task before a scheduled image feed selects it.

## Configuration

Add optional task `captureWindows` using the existing day and `HH:MM` conventions, plus `captureScheduleTimezone`. Add optional feed field `preCaptureSeconds`, bounded so it cannot create excessive work.

Outside all capture windows, the task is paused. A task with no windows retains current interval behavior. Overnight windows follow the same starting-day rule as image-feed slots.

## Scheduling semantics

1. On startup inside a window, capture immediately and start the normal interval cadence.
2. On entering a window, capture once, then continue by interval.
3. On leaving a window, stop future timers but allow an active capture to finish.
4. Before a feed switch, request one capture of the incoming task at `preCaptureSeconds`; reuse any active capture.
5. If the pre-capture fails, the feed still switches according to its deterministic schedule and serves that task's last-good image or `503`.
6. Daylight-saving transitions use the configured IANA timezone and are covered explicitly in tests.

## Implementation

Extract scheduler calculations into pure functions in `src/schedule.js`. Replace fixed `setInterval` usage with one-shot timers that calculate the next capture/window transition, avoiding drift and making hot-apply predictable. Deduplicate pre-capture events when several feeds select the same task at the same time.

Expose paused state and next capture time in authenticated status. Public metadata may show `paused` but not detailed scheduling configuration.

## Verification

- Validate empty, overlapping, overnight, and boundary windows.
- Test entry, exit, restart inside/outside a window, and `refreshIntervalSeconds: 0` semantics.
- Test feed pre-capture deduplication and active-operation reuse.
- Test spring-forward and fall-back transitions with an injected clock and fake timers.
- Test schedule-only hot updates without interrupting unrelated active captures.

## Invariants

Public image requests never trigger capture work. No task may overlap itself, while different tasks remain independent. Scheduled feeds continue selecting files without waiting for capture completion.
