import { leaseIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";

const release = await leaseIsolationWorkspace(process.argv[2]!);
console.log(`leased pid=${process.pid}`);
for await (const _ of console) break;
await release();
