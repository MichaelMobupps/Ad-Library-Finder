PLUG-AND-PLAY INSTALL (no folder paths needed)

1. Upload injection-hardening.zip to your Replit workspace (drag into the file tree at the top level).

2. Open the Shell and paste this one line:

   python3 -c "import zipfile;zipfile.ZipFile('injection-hardening.zip').extractall('_ih_patch')" && bash _ih_patch/apply.sh

3. When it prints "Republish after restart.", click Republish.

The script finds the right folder itself, backs up the originals, runs the
typecheck and test gates, builds, and mirrors. If any gate fails it stops and
prints a one-line restore command. Nothing is changed if a gate fails.

See PATCH-NOTES.md for what each file does.
