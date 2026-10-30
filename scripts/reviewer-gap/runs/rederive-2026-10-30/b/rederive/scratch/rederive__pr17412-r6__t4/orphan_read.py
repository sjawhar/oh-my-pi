"""Mirror of Detached's syscall pattern: an abandoned copy's thread stays parked in
read(2) on a shared pipe; a later reader of the same pipe (the 'kept' copy, or
the next command reading stdin) waits too. Who gets the bytes written next?"""
import os, threading, time

trials, stolen = 50, 0
for _ in range(trials):
    r, w = os.pipe()
    second = os.dup(r)
    got = {}

    def reader(name, fd):
        got[name] = os.read(fd, 64 * 1024)  # DetachedRequest::Read(64 KiB)

    abandoned = threading.Thread(target=reader, args=("abandoned", r), daemon=True)
    abandoned.start()
    time.sleep(0.02)  # copy started, then the run is cancelled; thread stays parked
    kept = threading.Thread(target=reader, args=("kept", second), daemon=True)
    kept.start()
    time.sleep(0.02)
    os.write(w, b"shared")
    os.close(w)
    kept.join(); abandoned.join(timeout=1)
    if got.get("abandoned") == b"shared":
        stolen += 1
print(f"abandoned thread took the payload in {stolen}/{trials} trials; kept copy got b'' (EOF) then")
