import { leaseIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
const cwd = process.argv[2]!;
const release = await leaseIsolationWorkspace(cwd);
console.log("leased");
await Bun.sleep(500);
await release();
console.log("released");
