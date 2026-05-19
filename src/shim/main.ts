#!/usr/bin/env bun
/**
 * choros MCP shim — Phase 4 placeholder.
 *
 * In v1.0 this becomes the only per-CC bun process: a thin MCP server
 * that forwards every tool call to the daemon's JSON-RPC socket and
 * re-emits daemon notifications as mcp.notification events.
 *
 * Current production entry is still `src/main.ts`. This file is
 * intentionally empty during Phase 1 — the daemon-side foundation
 * ships first; the shim wiring (Phase 4) replaces `src/main.ts`.
 */
export {}
