// Replaces this process with a program that is its own macOS privacy (TCC)
// responsible process. Without it, an app started from an editor, terminal or
// agent inherits that tool as "responsible": TCC then checks the tool, refuses
// to show Calendar or Location prompts, and the status stays "not determined".
//
// posix_spawn with POSIX_SPAWN_SETEXEC behaves like exec: the pid, working
// directory, environment, standard streams and signal delivery stay the same.
// The disclaim attribute is the mechanism terminals use for the same purpose.
// When it is unavailable, this falls back to a plain exec.
//
// Usage: macos-disclaim-exec <program> [args...]
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

extern char **environ;
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim)
    __attribute__((weak_import));

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <program> [args...]\n", argv[0]);
    return 2;
  }
  posix_spawnattr_t attrs;
  if (responsibility_spawnattrs_setdisclaim != NULL && posix_spawnattr_init(&attrs) == 0) {
    if (responsibility_spawnattrs_setdisclaim(&attrs, 1) == 0 &&
        posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETEXEC) == 0) {
      int rc = posix_spawn(NULL, argv[1], NULL, &attrs, argv + 1, environ);
      fprintf(stderr, "[kordi] Could not start %s as its own app (%s); starting it directly.\n", argv[1], strerror(rc));
    }
    posix_spawnattr_destroy(&attrs);
  }
  execv(argv[1], argv + 1);
  fprintf(stderr, "[kordi] Could not start %s: %s\n", argv[1], strerror(errno));
  return 127;
}
