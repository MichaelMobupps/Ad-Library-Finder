{ pkgs }: {
  deps = [
    # Chromium / Playwright headless-shell shared library deps.
    # NOTE: do NOT add pkgs.glibc here. Replit prepends nix glibc's bin/lib
    # paths into the LOGIN-shell LD_LIBRARY_PATH (not just REPLIT_LD_LIBRARY_PATH),
    # which breaks Node 20 — Node was built against glibc 2.38 and crashes if
    # the loader resolves libm/libc from nix glibc 2.33 first.
    # Chromium still gets a compatible glibc via transitive deps of the libs
    # below; browserSetup.ts plumbs that into the child process's
    # LD_LIBRARY_PATH explicitly.

    # libglib-2.0.so.0, libgobject-2.0.so.0, libgio-2.0.so.0
    pkgs.glib

    # libnss3.so, libnssutil3.so, libsmime3.so
    pkgs.nss
    # libnspr4.so
    pkgs.nspr

    # libatk-1.0.so.0
    pkgs.atk
    # libatk-bridge-2.0.so.0
    pkgs.at-spi2-atk
    # libatspi.so.0
    pkgs.at-spi2-core

    pkgs.cups
    # libdbus-1.so.3
    pkgs.dbus
    pkgs.libdrm
    # libxkbcommon.so.0
    pkgs.libxkbcommon
    # libgbm.so.1
    pkgs.mesa

    pkgs.pango
    pkgs.cairo
    # libasound.so.2
    pkgs.alsa-lib
    pkgs.expat

    # libudev.so.1
    pkgs.udev

    # X11 family
    pkgs.xorg.libX11
    pkgs.xorg.libXcomposite
    pkgs.xorg.libXdamage
    pkgs.xorg.libXext
    pkgs.xorg.libXfixes
    pkgs.xorg.libXrandr
    pkgs.xorg.libxcb
  ];
}