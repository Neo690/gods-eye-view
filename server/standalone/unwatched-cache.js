/**
 * Directories the standalone server and its local tooling write to while it
 * runs. None is source, and none should reload anything.
 */
const RUNTIME_WRITE_GLOBS = Object.freeze([
  '**/.gev-cache/**',
  '**/.gev-logs/**',
  // The local tool root may contain an extracted system tree with X11 symlink
  // loops; watching one makes Vite abort with ELOOP.
  '**/.gev-tools/**',
]);

/**
 * Keep the directories the app writes to out of the dev server's file watcher.
 *
 * Disk-cached providers write a file per response into `.gev-cache`, and the
 * voice debug log appends to `.gev-logs`. Left watched, each write costs the
 * watcher stat calls on libuv's thread pool, which `getaddrinfo` shares; heavy
 * cache writes have been seen to delay upstream DNS lookups.
 *
 * @returns {import('vite').Plugin} Config-only plugin; no server hooks.
 */
export function unwatchedRuntimeDirsPlugin() {
  return {
    name: 'gev-unwatched-runtime-dirs',
    apply: 'serve',
    config: () => ({
      server: { watch: { ignored: [...RUNTIME_WRITE_GLOBS] } },
    }),
  };
}
