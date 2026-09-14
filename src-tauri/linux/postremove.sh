#!/bin/sh
# Removing the package has to remove the privilege it installed. Focus Block's passwordless helper
# lives in /usr/local/bin with a NOPASSWD sudoers rule, and nothing outside this script cleans it up,
# so an uninstall would otherwise leave a standing root-write rule behind indefinitely.
#
# deb passes remove/purge/upgrade; rpm passes 0 on erase and 1 on upgrade. Only act on a real removal —
# acting during an upgrade would silently drop the user's saved authorization.
case "${1:-}" in
  remove|purge|0)
    rm -f /usr/local/bin/focusblock-apply /etc/sudoers.d/focusblock

    # A block can still be sitting in /etc/hosts when the package goes away. Leaving it behind means those
    # sites stay blocked with no app left to release them and no UI to explain why, so strip the managed
    # region on removal. Both marker pairs, because an install older than the rename used BLOCKER2. Nothing
    # happens unless a marker is actually present, and nothing is written unless awk succeeded.
    if grep -qE '^[[:space:]]*# BEGIN (FOCUSBLOCKER|BLOCKER2)[[:space:]]*$' /etc/hosts 2>/dev/null; then
      stage=$(mktemp /etc/.focusblock-remove.XXXXXX) || stage=
      if [ -n "$stage" ] && awk '
          /^[[:space:]]*# BEGIN (FOCUSBLOCKER|BLOCKER2)[[:space:]]*$/ { skip = 1; next }
          /^[[:space:]]*# END (FOCUSBLOCKER|BLOCKER2)[[:space:]]*$/   { skip = 0; next }
          !skip { print }
        ' /etc/hosts > "$stage"; then
        chmod 644 "$stage" && mv -f "$stage" /etc/hosts
      elif [ -n "$stage" ]; then
        rm -f "$stage"
      fi
    fi
    ;;
esac
exit 0
