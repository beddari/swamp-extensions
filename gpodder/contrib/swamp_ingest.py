# -*- coding: utf-8 -*-
#
# gPodder extension: run a swamp workflow once downloads have settled.
#
# Copy this file into gPodder's Extensions directory
# (~/Library/Application Support/gPodder/Extensions on macOS,
# ~/gPodder/Extensions elsewhere, or $GPODDER_HOME/Extensions), restart
# gPodder, enable "Run swamp after downloads" under Preferences > Extensions,
# and set repo to the swamp repository holding the gpodder definitions.
#
# Each finished download restarts a timer; when no download has finished for
# `delay` seconds, the workflow runs once, in the background. The delay also
# gives gPodder time to commit the episode's new state to its database before
# swamp reads it. A run that misses an episode is harmless: the library's
# downloads cursor returns it on the next run. While a run started here is
# still going, no second one starts; the timer waits for it instead.
#
# gPodder started from the Finder or a desktop launcher has a minimal PATH,
# so swamp is also looked for in ~/.local/bin, /opt/homebrew/bin and
# /usr/local/bin; set `swamp` to its full path if it lives elsewhere.

import logging
import os
import shutil
import subprocess
import threading

import gpodder

logger = logging.getLogger(__name__)

_ = gpodder.gettext

__title__ = _('Run swamp after downloads')
__description__ = _('Run a swamp workflow (default @beddari/gpodder-ingest) '
                    'once downloads have settled.')
__authors__ = 'Jan Ivar Beddari'
__category__ = 'post-download'
__only_for__ = 'gtk, cli'

DefaultConfig = {
    'repo': '',
    'workflow': '@beddari/gpodder-ingest',
    'swamp': 'swamp',
    'delay': 120,
}


class gPodderExtension:
    def __init__(self, container):
        self.container = container
        self.timer = None
        self.proc = None
        self.lock = threading.Lock()

    def on_unload(self):
        with self.lock:
            if self.timer is not None:
                self.timer.cancel()
                self.timer = None

    def on_episode_downloaded(self, episode):
        self.arm()

    def arm(self):
        with self.lock:
            if self.timer is not None:
                self.timer.cancel()
            self.timer = threading.Timer(
                float(self.container.config.delay), self.run)
            self.timer.daemon = True
            self.timer.start()

    def find_swamp(self):
        name = os.path.expanduser(self.container.config.swamp or 'swamp')
        if os.path.isabs(name):
            return name if os.access(name, os.X_OK) else None
        found = shutil.which(name)
        if found:
            return found
        for d in ('~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'):
            candidate = os.path.join(os.path.expanduser(d), name)
            if os.access(candidate, os.X_OK):
                return candidate
        return None

    def reap(self, proc):
        code = proc.wait()
        if code == 0:
            logger.info('%s: workflow finished', __title__)
        else:
            logger.warning('%s: workflow exited with %d; see the log in the '
                           'repository', __title__, code)

    def run(self):
        config = self.container.config
        repo = os.path.expanduser(config.repo or '')
        if not repo or not os.path.isfile(os.path.join(repo, '.swamp.yaml')):
            logger.warning('%s: repo is not a swamp repository: %r',
                           __title__, repo)
            return
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                busy = True
            else:
                busy = False
        if busy:
            # The run still going may predate the newest download; try again
            # after another delay rather than start a second run beside it.
            self.arm()
            return
        swamp = self.find_swamp()
        if swamp is None:
            logger.warning('%s: swamp not found; set its full path in the '
                           'extension\'s swamp option', __title__)
            return
        log = os.path.join(repo, '.swamp', 'gpodder-hook.log')
        try:
            os.makedirs(os.path.dirname(log), exist_ok=True)
            with open(log, 'ab') as out:
                proc = subprocess.Popen(
                    [swamp, 'workflow', 'run', config.workflow],
                    cwd=repo, stdin=subprocess.DEVNULL, stdout=out,
                    stderr=subprocess.STDOUT, close_fds=True,
                    start_new_session=True)
        except OSError as e:
            logger.warning('%s: could not start %s: %s', __title__, swamp, e)
            return
        with self.lock:
            self.proc = proc
        threading.Thread(target=self.reap, args=(proc,), daemon=True).start()
        logger.info('%s: started %s in %s', __title__, config.workflow, repo)
