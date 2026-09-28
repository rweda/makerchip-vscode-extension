/**
 * Cross-platform parallel watcher with deterministic cleanup.
 *
 * Replaces the previous inline shell pipeline, which was bash-only:
 *   { trap 'kill 0' EXIT INT TERM; npm run watch:main & ... & wait; }
 *
 * `trap 'kill 0'` worked because it signalled the whole process GROUP, so every descendant died.
 * That matters here: each watcher is a grandchild (npm -> sh -> node tsc), and killing only the
 * direct child leaves the `node` process running. Leaked `tsc -watch` processes are exactly what
 * the "Addressed an issue with lingering watchers" commit dealt with, so deterministic teardown
 * is the requirement, not just parallelism.
 *
 * Hence a script rather than a runner dependency: `run-p` and `concurrently` parallelise well,
 * but neither puts each task in its own process group, which is the part that makes a whole-tree
 * kill possible without guessing at the process hierarchy. Doing it here also keeps the
 * dev-dependency list unchanged.
 *
 * Verified 2026-09-23 on Linux: SIGINT to this script leaves zero surviving watchers.
 * Windows cleanup (taskkill) is UNVERIFIED — no Windows machine available to test on.
 *
 * Approach: start each child in its OWN process group (`detached`), then tear the whole group
 * down on exit. POSIX kills the negated pgid; Windows has no process groups to signal, so it
 * uses `taskkill /T` to walk the tree.
 */

const { spawn, spawnSync } = require('child_process');

const TASKS = ['watch:main', 'watch:webview', 'watch:html'];
const isWindows = process.platform === 'win32';

const children = TASKS.map(task => {
  // `shell: true` so `npm` resolves to npm.cmd on Windows. detached gives each child its own
  // process group, which is what makes a group kill possible below.
  const child = spawn(`npm run ${task}`, {
    shell: true,
    stdio: 'inherit',
    detached: !isWindows,
  });
  child.on('error', error => console.error(`[watch] ${task} failed to start: ${error.message}`));
  return { task, child };
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const { task, child } of children) {
    if (child.pid === undefined || child.exitCode !== null) {
      continue;
    }
    try {
      if (isWindows) {
        // No process groups: walk the tree instead. /T includes descendants, /F forces.
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        // Negative pid targets the whole process group, so `sh` and its `node` child both go.
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch (error) {
      // Already gone, or we lost the race with its own exit. Nothing useful to do.
      if (process.env.MAKERCHIP_WATCH_DEBUG) {
        console.error(`[watch] could not stop ${task}: ${error}`);
      }
    }
  }

  // Leave a moment for children to die before the parent's exit orphans anything.
  setTimeout(() => process.exit(signal === 'exit' ? 0 : 1), 200);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(signal));
}

// If any watcher dies on its own (e.g. a config error), stop the rest rather than leaving a
// half-running watch that looks healthy.
for (const { task, child } of children) {
  child.on('exit', code => {
    if (!shuttingDown) {
      console.error(`[watch] ${task} exited (${code}); stopping the others.`);
      shutdown('child-exit');
    }
  });
}
