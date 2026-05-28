import { useEffect, useState } from 'react';
import type { Project, ProjectSession } from '../types/app';

/**
 * UI-only rename overlay for project + session display names.
 *
 * Folder names on disk (`project.name`, `session.id`) stay the source of
 * truth — every API call, route, and persistence layer keeps using them.
 * This module just stores a per-user "preferred label" map in localStorage
 * and surfaces it through `projectDisplayName` / `sessionDisplayTitle`,
 * which the UI calls instead of touching the raw fields directly.
 *
 * Renames trigger a `customnames:changed` window event and a `storage` event
 * (cross-tab) so every consumer can re-read the override on the next render
 * via `useCustomNamesVersion()`.
 */

const PROJECT_KEY = 'pilotdeck:customProjectNames';
const SESSION_KEY = 'pilotdeck:customSessionTitles';
const CHANGE_EVENT = 'customnames:changed';

type NameMap = Record<string, string>;

function readMap(key: string): NameMap {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as NameMap) : {};
  } catch {
    return {};
  }
}

function writeMap(key: string, map: NameMap): void {
  localStorage.setItem(key, JSON.stringify(map));
  // Dispatch a synthetic event so same-tab listeners can refresh — the
  // native `storage` event only fires across tabs, so we always emit our
  // own here and additionally listen to `storage` for the cross-tab case.
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

// ── Project names ────────────────────────────────────────────────────────

export function getProjectCustomName(name: string): string | null {
  const value = readMap(PROJECT_KEY)[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Pass `null` or an empty string to clear an override and fall back to
 * `displayName || name`.
 */
export function setProjectCustomName(name: string, override: string | null): void {
  const map = readMap(PROJECT_KEY);
  const trimmed = override?.trim();
  if (trimmed) {
    map[name] = trimmed;
  } else {
    delete map[name];
  }
  writeMap(PROJECT_KEY, map);
}

/** Read the label any UI surface should show for a project row/breadcrumb. */
export function projectDisplayName(project: Project): string {
  return (
    getProjectCustomName(project.name) ||
    project.displayName ||
    project.name
  );
}

// ── Session titles ───────────────────────────────────────────────────────

export function getSessionCustomTitle(sessionId: string): string | null {
  const value = readMap(SESSION_KEY)[sessionId];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function setSessionCustomTitle(sessionId: string, override: string | null): void {
  const map = readMap(SESSION_KEY);
  const trimmed = override?.trim();
  if (trimmed) {
    map[sessionId] = trimmed;
  } else {
    delete map[sessionId];
  }
  writeMap(SESSION_KEY, map);
}

/** Built-in fallback chain for the original session title. */
function nativeSessionTitle(session: ProjectSession): string {
  const summary = (typeof session.summary === 'string' && session.summary) || '';
  const title = (typeof session.title === 'string' && session.title) || '';
  const name = (typeof session.name === 'string' && session.name) || '';
  return summary || title || name || session.id;
}

/** Read the label any UI surface should show for a session row/header. */
export function sessionDisplayTitle(session: ProjectSession): string {
  return getSessionCustomTitle(session.id) || nativeSessionTitle(session);
}

// ── React subscription hook ──────────────────────────────────────────────

/**
 * Returns a monotonically increasing counter that bumps every time a custom
 * name is written (same-tab via `customnames:changed`, cross-tab via the
 * native `storage` event). Components that render display names should call
 * this hook so they re-read after a rename.
 */
export function useCustomNamesVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const handler = () => setVersion((v) => v + 1);
    const storageHandler = (event: StorageEvent) => {
      if (event.key === PROJECT_KEY || event.key === SESSION_KEY) handler();
    };
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', storageHandler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', storageHandler);
    };
  }, []);
  return version;
}
