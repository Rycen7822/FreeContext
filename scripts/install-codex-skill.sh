#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_root="$(cd -- "$script_dir/.." && pwd)"
source_dir="$package_root/skills/freecontext"
skills_root="${FREECONTEXT_SKILLS_DIR:-$HOME/.agents/skills}"
target="$skills_root/freecontext"
mode="${1:-symlink}"

mkdir -p -- "$skills_root"
if [[ -e "$target" || -L "$target" ]]; then
  rm -rf -- "$target"
fi

case "$mode" in
  symlink)
    ln -s -- "$source_dir" "$target"
    ;;
  copy)
    cp -R -- "$source_dir" "$target"
    ;;
  *)
    printf 'usage: %s [symlink|copy]\n' "$0" >&2
    exit 2
    ;;
esac

printf 'Installed FreeContext skill at %s\n' "$target"
