import { leaseIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";

const release = await leaseIsolationWorkspace(process.argv[2]!);
console.log(`leased pid=${process.pid}`);
await new Promise<void>(resolve => process.on("SIGUSR2", () => resolve()));
await release();
process.exit(0);
