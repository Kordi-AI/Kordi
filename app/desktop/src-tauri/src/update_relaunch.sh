# Arguments are supplied by Rust, never interpolated into shell source.
pid=$1
bundle=$2
relaunch_arg=$3
launcher=$4
reporter=$5
remaining=$6

report_failure() {
    "$reporter" -e 'on run argv
display alert "Kordi update needs attention" message (item 1 of argv) as warning buttons {"OK"} default button "OK" giving up after 120
end run' "$1" >/dev/null 2>&1
}

# A timeout is a failure, not permission to launch over the old process.
while /bin/kill -0 "$pid" 2>/dev/null; do
    if [ "$remaining" -le 0 ]; then
        report_failure "Kordi did not finish quitting. Wait for it to close, then open Kordi from Applications. If it stays open, quit it manually first."
        exit 75
    fi
    /bin/sleep 0.1
    remaining=$((remaining - 1))
done

# LaunchServices owns the replacement. Never fall back to starting the binary
# directly: that bypasses the bundle launch and can recreate the Dock problem.
if "$launcher" "$bundle" --args "$relaunch_arg"; then
    exit 0
fi
report_failure "The update was installed, but Kordi could not reopen. Open Kordi from Applications."
exit 1
