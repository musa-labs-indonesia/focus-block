#!/bin/sh
# Runs after the package is installed (deb postinst, rpm %post) and again on upgrade.
#
# The package drops icons into /usr/share/icons/hicolor and a launcher into /usr/share/applications.
# Nothing rebuilds the caches for those two directories unless this script does, and a stale icon cache
# is exactly why a freshly installed app shows a generic placeholder in the app grid until the user
# logs out and back in.
#
# Everything here is best-effort, and nothing may abort: a non-zero exit from a package script leaves
# the package half-configured ("iF" in dpkg), which is far worse than a missing icon.
gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
update-desktop-database -q /usr/share/applications 2>/dev/null || true
xdg-desktop-menu forceupdate 2>/dev/null || true
exit 0
