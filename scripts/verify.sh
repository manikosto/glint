#!/bin/sh
# Checks that glint is what it says it is:
#  1. the vendored bundles rebuild byte for byte from the npm packages pinned in package-lock.json
#  2. the hooks module reaches only the engine capabilities listed in ALLOWED
#  3. no hand-written file reaches the network or evaluates strings as code
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
fail=0

echo "1. vendor bundles"
work=$(mktemp -d)
cp -R "$here" "$work/scripts"
mkdir -p "$work/hooks/vendor"
(cd "$work/scripts" && npm ci --silent --ignore-scripts >/dev/null 2>&1 && node build-vendor.mjs >/dev/null)
for f in prism.js mermaid-text.js; do
  a=$(shasum -a 256 "$root/hooks/vendor/$f" | cut -d' ' -f1)
  b=$(shasum -a 256 "$work/hooks/vendor/$f" | cut -d' ' -f1)
  if [ "$a" = "$b" ]; then echo "   ok   $f  $a"; else echo "   FAIL $f differs from its rebuild"; fail=1; fi
done
rm -rf "$work"

echo "2. engine capabilities"
ALLOWED='$.command.register $.command.run $.config.set $.env.get $.process.run $.state.get $.state.set $.ui.copy $.ui.resolve $.ui.toast'
calls=$(claude plugin validate "$root" 2>&1 | grep 'calls:' | sed 's/.*calls: //; s/ (via [^)]*)//g; s/,//g')
for c in $calls; do
  case " $ALLOWED " in *" $c "*) ;; *) echo "   FAIL unexpected call $c"; fail=1 ;; esac
done
echo "   calls: $calls"
grep -q 'process.run' "$root/hooks/register.tsx" && grep -n "process.run" "$root/hooks/register.tsx" | sed 's/^/   process.run at line /'

echo "3. network and eval in hand-written code"
if grep -rnE 'fetch\(|XMLHttpRequest|WebSocket|\beval\(|new Function|\$\.http' "$root/hooks" --include='*.ts' --include='*.tsx' | grep -v '/vendor/'; then fail=1; else echo "   ok   none"; fi

[ $fail -eq 0 ] && echo "verified" || { echo "NOT verified"; exit 1; }
