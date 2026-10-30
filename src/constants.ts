export const PLUGIN_ID = "ooospooky.port-labels";
export const SOURCE = "plugin:ooospooky.port-labels";
export const TOKEN_NAME = "dev_servers";
export const BADGE = "⚡";
export const BADGE_PREFIX = "⚡ ";
export const INTERVAL_MS = 5000;
export const TTL_MS = 25000;
export const RENEW_MS = 10000;
// Each pane token push re-sends the whole grid to SSH clients (herdr #4428), so pane tokens renew less often than Space tokens
export const PANE_TOKEN_TTL_MS = 60000;
export const PANE_TOKEN_RENEW_MS = 30000;
export const DEBOUNCE_MS = 300;
export const TOKEN_MAX_LENGTH = 80;
