#!/bin/sh
# herdr runs hooks with its own startup environment, whose PATH may lack node or carry a stale fnm shell directory.
set -u

MIN_NODE_VERSION="22.18"
min_major="${MIN_NODE_VERSION%.*}"
min_minor="${MIN_NODE_VERSION#*.}"
seen=""

version_ok() {
  numbers="${1#v}"
  case "$numbers" in *.*) ;; *) return 1 ;; esac
  major="${numbers%%.*}"
  after_major="${numbers#*.}"
  minor="${after_major%%.*}"
  case "$major" in '' | *[!0-9]*) return 1 ;; esac
  case "$minor" in '' | *[!0-9]*) return 1 ;; esac
  # Node 23.0–23.5 strip types only behind --experimental-strip-types
  case "$numbers" in 23.[0-5] | 23.[0-5].*) return 1 ;; esac
  [ "$major" -gt "$min_major" ] || { [ "$major" -eq "$min_major" ] && [ "$minor" -ge "$min_minor" ]; }
}

try_node() {
  candidate="$1"
  shift
  [ -f "$candidate" ] && [ -x "$candidate" ] || return 0
  version="$("$candidate" --version 2>/dev/null)" || return 0
  seen="${seen:+$seen, }$version"
  if version_ok "$version"; then exec "$candidate" "$@" 3<&-; fi
}

try_version_dirs() {
  parent="$1"
  bin_suffix="$2"
  shift 2
  [ -d "$parent" ] || return 0
  # The list arrives on fd 3 from a here-document: a pipe would exec in a subshell, and stdin stays the caller's.
  while IFS= read -r version_dir <&3; do
    [ -n "$version_dir" ] && try_node "$parent/$version_dir/$bin_suffix/node" "$@"
  done 3<<EOF
$(ls -1 "$parent" | sort -t. -k1.2,1nr -k2,2nr -k3,3nr)
EOF
}

path_node="$(command -v node 2>/dev/null)" || path_node=""
case "$path_node" in /*) try_node "$path_node" "$@" ;; esac

if [ -n "${WITH_NODE_EXTRA_DIRS:-}" ]; then
  remaining="$WITH_NODE_EXTRA_DIRS"
  while [ -n "$remaining" ]; do
    extra_dir="${remaining%%:*}"
    case "$remaining" in *:*) remaining="${remaining#*:}" ;; *) remaining="" ;; esac
    [ -n "$extra_dir" ] && try_node "$extra_dir/node" "$@"
  done
else
  home="${HOME:-}"
  try_node "${FNM_DIR:-}/aliases/default/bin/node" "$@"
  try_node "$home/.local/share/fnm/aliases/default/bin/node" "$@"
  try_node "$home/Library/Application Support/fnm/aliases/default/bin/node" "$@"
  try_version_dirs "$home/.local/share/fnm/node-versions" installation/bin "$@"
  try_version_dirs "${NVM_DIR:-$home/.nvm}/versions/node" bin "$@"
  try_node "$home/.volta/bin/node" "$@"
  try_node "$home/.local/share/mise/shims/node" "$@"
  try_node "$home/.asdf/shims/node" "$@"
  try_node /opt/homebrew/bin/node "$@"
  try_node /usr/local/bin/node "$@"
  try_node "$home/.local/bin/node" "$@"
fi

echo "port-labels: needs Node $MIN_NODE_VERSION or newer on the PATH herdr started with (found: ${seen:-none}); install it from nodejs.org, fnm, nvm or Homebrew, or start herdr from a shell where node --version works." >&2
exit 127
