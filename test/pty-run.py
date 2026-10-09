"""Runs a command in a real pseudo-terminal for test/pty-exit.test.ts.

usage: pty-run.py <cwd> <steps-json> <cmd> [args...]
steps-json: [[trigger, keys], ...]. Waits until the output contains trigger (searching after the
previous trigger), pauses briefly, writes keys. Then waits up to 10 s for the child to exit.
Prints one JSON line: {"code": <int>|"TIMEOUT", "output": "<text>"}.
"""
import json
import os
import pty
import select
import signal
import sys
import time

cwd, steps = sys.argv[1], json.loads(sys.argv[2])
cmd = sys.argv[3:]

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(cmd[0], cmd)

buf = b""
pos = 0
status = None


def pump(timeout):
    global buf
    r, _, _ = select.select([fd], [], [], timeout)
    if r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            return False
        if not data:
            return False
        buf += data
    return True


def reap():
    global status
    if status is None:
        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            status = st
    return status is not None


alive = True
for trigger, keys in steps:
    deadline = time.time() + 10
    needle = trigger.encode()
    while needle not in buf[pos:] and time.time() < deadline and alive:
        alive = pump(0.1)
    idx = buf.find(needle, pos)
    if idx >= 0:
        pos = idx + len(needle)
    time.sleep(0.4)
    try:
        os.write(fd, keys.encode())
    except OSError:
        pass

deadline = time.time() + 10
while time.time() < deadline and not reap():
    pump(0.1)
if status is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    code = "TIMEOUT"
else:
    code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)
# drain what is left
while True:
    r, _, _ = select.select([fd], [], [], 0.1)
    if not r:
        break
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    buf += d
print(json.dumps({"code": code, "output": buf.decode("utf8", "replace")}))
