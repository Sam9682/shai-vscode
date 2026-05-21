#!/bin/bash

echo "Detailed analysis of lines written in the last 2 days..."
echo "======================================================"

# Get the commits from the last 2 days
echo "Commits from the last 2 days:"
git log --oneline --since="2 days ago"

echo ""
echo "Changes per commit:"
echo "==================="

# Show detailed changes for each commit
for commit in $(git log --oneline --since="2 days ago" --format="%H"); do
    echo "Commit: $(git log --oneline -1 $commit)"
    echo "Changes:"
    git show --stat $commit
    echo ""
done

echo ""
echo "Total lines added/deleted in last 2 days:"
echo "========================================"

# Get total additions and deletions
git diff --shortstat $(git log --oneline --since="2 days ago" | tail -1 | cut -d' ' -f1) HEAD 2>/dev/null || echo "No diff available"