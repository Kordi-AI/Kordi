// Set once a request in this app session left macOS notification permission undetermined: macOS
// will not show the prompt to this process, so asking again would only repeat a silent no-op.
// Every notification surface then offers System Settings instead of another request.
let stalled = false;

export function notificationRequestStalled() {
  return stalled;
}

export function markNotificationRequestStalled() {
  stalled = true;
}

export function resetNotificationRequestStallForTests() {
  stalled = false;
}
