# U-Claw Brand Icon

U-Claw uses the original red lobster badge from the earlier Windows release: a
Segoe UI Emoji lobster centred on a white-to-pale-red rounded square. This is the
recognisable product mark and should not be replaced with the later flat lobster
illustration or the blue side-profile prawn.

The committed `icon-uclaw.png` is the cross-platform master. Keep it as a PNG so
Windows, macOS and Linux builds do not depend on the host system's colour-emoji
font. The transparent `src/assets/logo.png` is the matching in-app mark used by
the setup page and sidebar.

Always inspect the 16×16 and 32×32 outputs after regeneration. Those sizes are
what users actually see in Explorer, the taskbar and the system tray.
