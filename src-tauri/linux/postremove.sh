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
    ;;
esac
exit 0
