#!/usr/bin/env bash
#
# Prepare a host to run DeployHub.
#
# Creates the data root, the workspace directory, and an empty secrets file, all owned by the
# uid the container runs as. Nothing else. It does not install packages, write configuration,
# pull images, or start containers — those are decisions, and this script only does the one
# thing that must happen before `docker run` and cannot happen after it.
#
# Why it exists: Docker creates a missing bind-mount source directory as `root:root`, so
# starting the containers before preparing the host silently produces a data root the container
# cannot write. The result is a worker crash-looping on `unable to open database file`. That
# was a real first-install failure, and a step that can be skipped without immediate
# consequence will be skipped.
#
# Safe to re-run. It reports what it changed and what was already correct, and changes nothing
# that is already right.
#
#   sudo docs/ops/install.sh
#   sudo docs/ops/install.sh --dry-run
#   sudo docs/ops/install.sh --root /srv/deployhub --uid 1500 --gid 1500
#
# See docs/docker.md for what happens next.

set -euo pipefail

readonly DEFAULT_ROOT="/var/lib/deployhub"
readonly DEFAULT_UID=1000
readonly DEFAULT_GID=1000
readonly DIR_MODE=750
readonly SECRETS_MODE=600

root="${DEPLOYHUB_ROOT:-$DEFAULT_ROOT}"
owner_uid="$DEFAULT_UID"
owner_gid="$DEFAULT_GID"
dry_run=false

changed=0
already=0

usage() {
  sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

note()  { printf '  ok      %s\n' "$1"; already=$((already + 1)); }
did()   { printf '  changed %s\n' "$1"; changed=$((changed + 1)); }
would() { printf '  would   %s\n' "$1"; changed=$((changed + 1)); }

# Apply an action, or describe it under --dry-run. Every mutation goes through here so that
# --dry-run cannot drift out of step with what a real run does.
apply() {
  local description="$1"
  shift
  if [ "$dry_run" = true ]; then
    would "$description"
    return 0
  fi
  "$@"
  did "$description"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || die "--root needs a path"; root="$2"; shift 2 ;;
    --uid)  [ $# -ge 2 ] || die "--uid needs a number";  owner_uid="$2"; shift 2 ;;
    --gid)  [ $# -ge 2 ] || die "--gid needs a number";  owner_gid="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'error: unknown option %s\n\n' "$1" >&2; usage 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Refuse anything that is not plainly a data directory.
#
# This script chowns what it is pointed at. A typo that points it at a system directory must
# fail rather than rewrite ownership of the host, so the path is checked against a deny list
# and a shape rule *before* anything is created — and note that it never chowns recursively,
# so even a mistake that gets past this affects one directory rather than a tree.
# ---------------------------------------------------------------------------

case "$root" in
  /*) : ;;
  *)  die "--root must be an absolute path (got '$root')" ;;
esac

case "$root" in
  *..*) die "--root must not contain '..' (got '$root')" ;;
esac

# Strip trailing slashes without ever reducing the path to the empty string — `/` must survive
# as `/` so the deny list below can reject it, rather than becoming `` and skipping every check.
while [ "$root" != "/" ] && [ "${root%/}" != "$root" ]; do
  root="${root%/}"
done

# Reserved: the filesystem root, and every top-level directory a distribution owns. Listed
# explicitly rather than inferred — an allow-list of shapes would still admit /etc/deployhub.
for reserved in / /bin /boot /dev /etc /home /lib /lib32 /lib64 /media /mnt /opt /proc /root \
                /run /sbin /srv /sys /tmp /usr /var /var/lib /var/log /var/run /var/tmp; do
  if [ "$root" = "$reserved" ]; then
    die "refusing to use '$root': that is a system directory, not a data directory"
  fi
done

# Two segments minimum (`/srv/deployhub`, not `/deployhub`), so a half-typed path cannot land
# on something important.
depth="$(printf '%s\n' "${root#/}" | awk -F/ '{print NF}')"
if [ -z "$depth" ] || [ "$depth" -lt 2 ]; then
  die "refusing to use '$root': expected a nested path such as /var/lib/deployhub"
fi

if [ -L "$root" ]; then
  die "refusing to use '$root': it is a symlink, and chown would follow it somewhere unintended"
fi

if [ -e "$root" ] && [ ! -d "$root" ]; then
  die "'$root' exists and is not a directory"
fi

case "$owner_uid" in ''|*[!0-9]*) die "--uid must be a number (got '$owner_uid')" ;; esac
case "$owner_gid" in ''|*[!0-9]*) die "--gid must be a number (got '$owner_gid')" ;; esac

if [ "$owner_uid" = "0" ]; then
  die "refusing to give the data root to root: the container runs unprivileged, and root-owned is the failure this script exists to prevent"
fi

if [ "$dry_run" = false ] && [ "$(id -u)" -ne 0 ]; then
  die "must run as root to set ownership — try: sudo $0 $*"
fi

readonly projects="$root/projects"
readonly secrets="$root/secrets.json"

printf 'Preparing %s for uid %s:%s\n\n' "$root" "$owner_uid" "$owner_gid"

# ---------------------------------------------------------------------------
# Directories. Created if absent, corrected if wrong, left alone if right.
# ---------------------------------------------------------------------------

ensure_dir() {
  local path="$1"

  if [ ! -d "$path" ]; then
    apply "created $path" mkdir -p "$path"
  else
    note "$path exists"
  fi

  # `chown` without -R, deliberately. This script owns three paths and corrects exactly those;
  # it never rewrites ownership of a tree it did not create. Pre-existing files with the wrong
  # owner are reported at the end instead, so the operator decides.
  local current_owner="unknown"
  if [ -d "$path" ]; then
    current_owner="$(stat -c '%u:%g' "$path" 2>/dev/null || stat -f '%u:%g' "$path")"
  fi
  if [ "$current_owner" != "$owner_uid:$owner_gid" ]; then
    apply "chown $owner_uid:$owner_gid $path (was $current_owner)" \
      chown "$owner_uid:$owner_gid" "$path"
  else
    note "$path is owned by $owner_uid:$owner_gid"
  fi

  local current_mode="unknown"
  if [ -d "$path" ]; then
    current_mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")"
  fi
  if [ "$current_mode" != "$DIR_MODE" ]; then
    apply "chmod $DIR_MODE $path (was $current_mode)" chmod "$DIR_MODE" "$path"
  else
    note "$path is mode $DIR_MODE"
  fi
}

ensure_dir "$root"
ensure_dir "$projects"

# ---------------------------------------------------------------------------
# The secrets file.
#
# Created empty when absent, never overwritten when present — it holds real credentials, and
# there is no write path in the platform to recreate them from.
# ---------------------------------------------------------------------------

if [ -e "$secrets" ] && [ ! -f "$secrets" ]; then
  die "'$secrets' exists and is not a regular file"
fi

if [ ! -f "$secrets" ]; then
  if [ "$dry_run" = true ]; then
    would "created $secrets containing {}"
  else
    install -o "$owner_uid" -g "$owner_gid" -m "$SECRETS_MODE" /dev/null "$secrets"
    printf '{}\n' > "$secrets"
    did "created $secrets containing {}"
  fi
else
  note "$secrets exists (left untouched — it holds real credentials)"

  secrets_owner="$(stat -c '%u:%g' "$secrets" 2>/dev/null || stat -f '%u:%g' "$secrets")"
  if [ "$secrets_owner" != "$owner_uid:$owner_gid" ]; then
    apply "chown $owner_uid:$owner_gid $secrets (was $secrets_owner)" \
      chown "$owner_uid:$owner_gid" "$secrets"
  else
    note "$secrets is owned by $owner_uid:$owner_gid"
  fi

  secrets_mode="$(stat -c '%a' "$secrets" 2>/dev/null || stat -f '%Lp' "$secrets")"
  if [ "$secrets_mode" != "$SECRETS_MODE" ]; then
    apply "chmod $SECRETS_MODE $secrets (was $secrets_mode)" chmod "$SECRETS_MODE" "$secrets"
  else
    note "$secrets is mode $SECRETS_MODE"
  fi
fi

# ---------------------------------------------------------------------------
# Report, rather than fix, anything else with the wrong owner.
#
# A recursive chown of an operator-supplied path is the one thing this script must not do. If a
# previous run of the containers left root-owned files behind, naming them is more useful than
# silently rewriting a tree — and the operator can see whether the list is what they expect.
# ---------------------------------------------------------------------------

stray=""
if [ -d "$root" ]; then
  stray="$(find "$root" -mindepth 1 ! -uid "$owner_uid" -print 2>/dev/null | head -20 || true)"
fi

printf '\n'
if [ -n "$stray" ]; then
  printf 'Files under %s are not owned by uid %s:\n\n' "$root" "$owner_uid"
  printf '%s\n' "$stray" | sed 's/^/  /'
  printf '\nThese are left alone deliberately: this script does not chown trees it did not\n'
  printf 'create. Review the list, then if it is what you expect:\n\n'
  printf '  sudo chown -R %s:%s %s\n\n' "$owner_uid" "$owner_gid" "$root"
fi

if [ "$dry_run" = true ]; then
  printf 'Dry run: %s change(s) would be made, %s already correct.\n' "$changed" "$already"
  printf 'Re-run without --dry-run to apply.\n'
  exit 0
fi

printf '%s change(s) made, %s already correct.\n' "$changed" "$already"
if [ -z "$stray" ]; then
  printf '\n%s is ready. Next: docs/docker.md § Run command.\n' "$root"
fi
