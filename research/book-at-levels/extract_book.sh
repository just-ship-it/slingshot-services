#!/usr/bin/env bash
# Extract top-of-book, front-month outright only, last update per SECOND.
# 1.1GB/day -> a few hundred KB, which is what makes 333 days tractable.
f="$1"; out="$2"
# front month = highest row count among outright symbols (no '-' = no calendar spread)
sym=$(awk -F, 'NR>1 && $20 !~ /-/ {c[$20]++} END{m=0; for(s in c) if(c[s]>m){m=c[s]; b=s} print b}' "$f")
awk -F, -v S="$sym" 'NR>1 && $20==S && $14!="" && $15!="" {
    sec=substr($1,1,19);
    line[sec]=sec","$14","$15","$16","$17","$18","$19
}
END{ for(s in line) print line[s] }' "$f" | sort > "$out"
echo "$(basename $f) sym=$sym rows=$(wc -l < $out)"
