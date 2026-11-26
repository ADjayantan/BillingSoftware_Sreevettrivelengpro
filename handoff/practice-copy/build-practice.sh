# Builds the practice copy: the practice address, and every name of the env files blanked (an empty variable wins over the file).
cd "$1" || exit 1
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_local
for n in $(cat .env.local .env.production.local 2>/dev/null | grep -oE '^[A-Z0-9_]+' | sort -u); do case $n in NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) ;; *) export "$n=";; esac; done
npm run build; echo "build exit $?"
