"""FIFO version of the trigger: run 1 `value=$(<f)` times out (its Detached thread
stays in read(2)); run 2 `value=$(<f)` then waits; a producer writes a line."""
import os, tempfile, threading, time

d = tempfile.mkdtemp(); f = os.path.join(d, "f"); os.mkfifo(f)
idle_writer = os.open(f, os.O_RDWR)  # like the test's idle writer: lets open() succeed
got = {}
def substitution(name):
    fd = os.open(f, os.O_RDONLY)
    got[name] = os.read(fd, 64 * 1024)
threading.Thread(target=substitution, args=("run1-abandoned",), daemon=True).start()
time.sleep(0.35)  # run 1 deadline hits; abort drops the future, thread stays parked
threading.Thread(target=substitution, args=("run2",), daemon=True).start()
time.sleep(0.05)
w = os.open(f, os.O_WRONLY); os.write(w, b"payload\n"); os.close(w); os.close(idle_writer)
time.sleep(0.2)
print(got)
