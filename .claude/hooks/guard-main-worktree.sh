#!/usr/bin/env bash
# guard-main-worktree.sh — keep the shared main worktree pinned to master.
#
# /home/daha/code/mindblown is not just one checkout among many: agents load
# the mindblown MCP from it via tsx. A session that switches it to a feature
# branch silently changes the tool code every agent on this box is running,
# and (as happened 2026-07-27) moves HEAD under any other session working
# there, so its next commit lands on the wrong branch.
#
# PreToolUse/Bash hook: reads the tool call as JSON on stdin, emits a deny
# decision for branch switches inside MAIN, stays silent otherwise.
#
# Escape hatch: MB_ALLOW_MAIN_SWITCH=1, either exported or inline in the
# command itself.
set -uo pipefail

# Derived, not hardcoded, so this travels with the repo instead of with
# one machine's directory layout. `git worktree list` always reports the
# main worktree first — asked from a linked worktree it still names the
# main one, which is exactly the comparison this guard needs.
main_worktree_of() {
  git -C "${1:-.}" worktree list --porcelain 2>/dev/null |
    awk '/^worktree /{print $2; exit}'
}
default_branch_of() {
  local ref
  ref=$(git -C "${1:-.}" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null)
  [[ -n "$ref" ]] && { printf '%s' "${ref##*/}"; return; }
  printf 'master'
}

# Any failure in here must fail OPEN. A broken guard that blocks every bash
# call is worse than the collision it prevents.
input=$(cat 2>/dev/null) || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[[ -n "$cmd" ]] || exit 0

# Fast path — most commands never mention git.
case "$cmd" in *git*) ;; *) exit 0 ;; esac

[[ "${MB_ALLOW_MAIN_SWITCH:-}" == "1" ]] && exit 0
[[ "$cmd" == *MB_ALLOW_MAIN_SWITCH=1* ]] && exit 0

deny() {
  jq -cn --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

abspath() { # $1 path, $2 base
  local p="$1" base="$2"
  [[ "$p" == /* ]] || p="$base/$p"
  realpath -m "$p" 2>/dev/null || printf '%s' "$p"
}

cwd_now="$PWD"

# One simple command per line, so `cd X && git switch y` is two steps.
while IFS= read -r seg; do
  [[ -n "${seg// }" ]] || continue
  read -ra tok <<<"$seg" || continue
  [[ ${#tok[@]} -gt 0 ]] || continue

  # Drop leading VAR=value assignments.
  idx=0
  while [[ ${idx} -lt ${#tok[@]} && "${tok[$idx]}" == *=* && "${tok[$idx]}" != -* && "${tok[$idx]}" != */* ]]; do
    idx=$((idx + 1))
  done
  [[ ${idx} -lt ${#tok[@]} ]] || continue
  head="${tok[$idx]}"

  if [[ "$head" == "cd" ]]; then
    [[ -n "${tok[$((idx + 1))]:-}" ]] && cwd_now=$(abspath "${tok[$((idx + 1))]}" "$cwd_now")
    continue
  fi

  [[ "$head" == "git" ]] || continue

  # Walk git's own options to find -C (which retargets the repo) and the
  # subcommand.
  gdir="$cwd_now"
  sub=""
  i=$((idx + 1))
  while [[ $i -lt ${#tok[@]} ]]; do
    case "${tok[$i]}" in
      -C) gdir=$(abspath "${tok[$((i + 1))]:-.}" "$cwd_now"); i=$((i + 2)) ;;
      -c) i=$((i + 2)) ;;
      --git-dir=*|--work-tree=*|-*) i=$((i + 1)) ;;
      *) sub="${tok[$i]}"; i=$((i + 1)); break ;;
    esac
  done

  [[ "$sub" == "checkout" || "$sub" == "switch" ]] || continue

  gdir=$(abspath "$gdir" "$cwd_now")
  MAIN=$(main_worktree_of "$gdir")
  [[ -n "$MAIN" ]] || continue
  MAIN=$(realpath -m "$MAIN" 2>/dev/null || printf '%s' "$MAIN")
  [[ "$gdir" == "$MAIN" ]] || continue
  ALLOWED_BRANCH=$(default_branch_of "$gdir")

  rest=("${tok[@]:$i}")

  # `--` means "everything after is a path" — a file checkout, never a
  # branch switch.
  is_path_checkout=0
  creates_branch=0
  positional=""
  for a in "${rest[@]:-}"; do
    case "$a" in
      --) is_path_checkout=1; break ;;
      # A bare `-` is the previous branch, not a flag — `checkout -` off
      # master is exactly the switch this guard exists to stop.
      -) [[ -z "$positional" ]] && positional="-" ;;
      -b|-B) creates_branch=1 ;;
      -c|-C) [[ "$sub" == "switch" ]] && creates_branch=1 ;;
      -*) ;;
      *) [[ -z "$positional" ]] && positional="$a" ;;
    esac
  done
  [[ $is_path_checkout -eq 1 ]] && continue

  if [[ $creates_branch -eq 1 ]]; then
    deny "Blocked: creating a branch in $MAIN. That checkout is the MCP source every agent loads, and other sessions may be working in it — a branch switch there moves HEAD under them. Use your own worktree (\`git worktree add ../mindblown-<slug>\`), or re-run with MB_ALLOW_MAIN_SWITCH=1 if you really mean it."
  fi

  [[ -n "$positional" ]] || continue
  [[ "$positional" == "$ALLOWED_BRANCH" ]] && continue
  # A checkout of an existing file/dir is a path restore, not a switch.
  [[ -e "$gdir/$positional" ]] && continue

  deny "Blocked: '$sub $positional' in $MAIN. That checkout must stay on $ALLOWED_BRANCH — it is the MCP source every agent loads via tsx, and other sessions may be working in it. Use your own worktree (\`git worktree add ../mindblown-<slug> $positional\`), or re-run with MB_ALLOW_MAIN_SWITCH=1 if you really mean it."
# NOTE: '%s\n', not '%s'. Without the trailing newline `read` returns
# non-zero on the last segment and the loop body never runs for it — which
# silently let every single-command `git checkout -b` straight through.
done < <(printf '%s\n' "$cmd" | sed -E 's/(\|\||&&|;|\|)/\n/g')

exit 0
