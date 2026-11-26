#!/usr/bin/env bash
# After `npm run make`: proves the locks of the built exe (desktop/README.md). Git Bash on Windows.
# It opens the live sign-in page for a few seconds (nobody signs in) and closes it again.
cd "$(dirname "$0")/.." || exit 1
EXE=out/StudFlow-win32-x64/StudFlow.exe
SETUP=out/make/squirrel.windows/x64/StudFlow-Setup.exe
wrong=0
say() { if [ "$1" = ok ]; then echo "ok    $2"; else echo "WRONG $2"; wrong=$((wrong + 1)); fi; }
stop() { taskkill //F //IM StudFlow.exe > /dev/null 2>&1; true; }

fuses=$(npx @electron/fuses read --app "$EXE" 2>&1)
for line in "RunAsNode is Disabled" "EnableCookieEncryption is Enabled" "EnableNodeOptionsEnvironmentVariable is Disabled" \
  "EnableNodeCliInspectArguments is Disabled" "EnableEmbeddedAsarIntegrityValidation is Enabled" "OnlyLoadAppFromAsar is Enabled" \
  "GrantFileProtocolExtraPrivileges is Disabled"; do
  case "$fuses" in *"$line"*) say ok "fuse: $line" ;; *) say wrong "fuse: $line" ;; esac
done

timeout 12 "$EXE" > /dev/null 2>&1
code=$?; stop
[ $code -eq 124 ] && say ok "a plain start keeps running" || say wrong "a plain start stopped (exit $code)"

# MSYS_NO_PATHCONV: hand /SWITCH over as typed, not turned into a Git folder.
for switch in --remote-debugging-port=9555 --remote-debugging-pipe --inspect=9229 --no-sandbox --disable-web-security \
  --ignore-certificate-errors --proxy-server=127.0.0.1:9 /REMOTE-DEBUGGING-PORT=9556; do
  MSYS_NO_PATHCONV=1 timeout 25 "$EXE" "$switch" > /dev/null 2>&1
  code=$?; stop
  [ $code -eq 1 ] && say ok "refuses $switch" || say wrong "started with $switch (exit $code)"
done
curl -s --max-time 3 http://127.0.0.1:9555/json/version > /dev/null && say wrong "port 9555 answers" || say ok "no debugging port answers"

said=$(ELECTRON_RUN_AS_NODE=1 timeout 10 "$EXE" -e "console.log(41+1)" 2>&1); stop
case "$said" in *42*) say wrong "runs as plain Node" ;; *) say ok "does not run as plain Node" ;; esac

copy=$(mktemp -d)
cp -r out/StudFlow-win32-x64/. "$copy"
node -e "const fs=require('fs');const f=process.argv[1];const b=fs.readFileSync(f);const i=b.indexOf('studflow-six.vercel.app');if(i<0)process.exit(2);b.write('studflow-evi.vercel.app',i);fs.writeFileSync(f,b)" "$copy/resources/app.asar"
timeout 15 "$copy/StudFlow.exe" > /dev/null 2>&1
code=$?; stop; rm -rf "$copy"
[ $code -ne 124 ] && say ok "a changed archive does not start" || say wrong "a changed archive started"

echo "SHA-256 of $SETUP:"
sha256sum "$SETUP" | cut -d' ' -f1
echo "$wrong wrong"
exit $wrong
