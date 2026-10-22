import { BADGE, BADGE_PREFIX, TOKEN_MAX_LENGTH } from "./constants.ts";

const ORIGINAL_SEPARATOR = " | ";
const DIGITS_PATTERN = /^\d+$/;

function sortedUnique(ports: number[]): number[] {
  return [...new Set(ports)].sort((left, right) => left - right);
}

// herdr-automatic-rename owns a leading "[N] " jump-key prefix; the badge goes after it so the two never fight
const JUMP_KEY_PREFIX = /^\[\d+\] /;

function splitJumpKeyPrefix(label: string): { prefix: string; rest: string } {
  const match = JUMP_KEY_PREFIX.exec(label);
  return match ? { prefix: match[0], rest: label.slice(match[0].length) } : { prefix: "", rest: label };
}

// A badge anywhere counts: another renamer that moves ours must never make us add a second one
export function hasBadge(label: string | null): boolean {
  return label !== null && label.includes(BADGE_PREFIX);
}

export function withBadge(label: string): string {
  if (hasBadge(label)) return label;
  const { prefix, rest } = splitJumpKeyPrefix(label);
  return prefix + BADGE_PREFIX + rest;
}

export function withoutBadge(label: string): string {
  const { prefix, rest } = splitJumpKeyPrefix(label);
  return rest.startsWith(BADGE_PREFIX) ? prefix + rest.slice(BADGE_PREFIX.length) : label;
}

export function paneLabel(ports: number[], original: string | null): string {
  const portPart = BADGE_PREFIX + sortedUnique(ports).join(" ");
  return original ? portPart + ORIGINAL_SEPARATOR + original : portPart;
}

// A following digit means more or longer ports: "⚡ 5176" must not match inside "⚡ 5176 5177" or "⚡ 51760"
export function carriesPortLabel(label: string, ports: number[]): boolean {
  return new RegExp(`${paneLabel(ports, null)}(?! ?\\d)`).test(label);
}

export function parsePaneLabel(label: string | null): { ports: number[]; original: string | null } {
  if (label === null || !label.startsWith(BADGE_PREFIX)) return { ports: [], original: label };
  const body = label.slice(BADGE_PREFIX.length);
  const separatorIndex = body.indexOf(ORIGINAL_SEPARATOR);
  const portPart = separatorIndex === -1 ? body : body.slice(0, separatorIndex);
  const original = separatorIndex === -1 ? "" : body.slice(separatorIndex + ORIGINAL_SEPARATOR.length).trim();
  const ports = portPart.split(/\s+/).filter((token) => DIGITS_PATTERN.test(token)).map(Number);
  return { ports: sortedUnique(ports), original: original === "" ? null : original };
}

export function spaceToken(ports: number[]): string {
  const sorted = sortedUnique(ports);
  const full = BADGE + sorted.join(" ");
  if (full.length <= TOKEN_MAX_LENGTH) return full;
  for (let keep = sorted.length - 1; keep >= 0; keep--) {
    const candidate = `${BADGE}${sorted.slice(0, keep).join(" ")} +${sorted.length - keep}`;
    if (candidate.length <= TOKEN_MAX_LENGTH) return candidate;
  }
  return full.slice(0, TOKEN_MAX_LENGTH);
}
