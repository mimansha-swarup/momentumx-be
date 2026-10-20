import { processLegacyUsers, LegacyMode } from "./legacy-channel.js";
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "audit";
  if (!["audit", "snapshot", "restore"].includes(mode)) throw Error("Usage: legacy-channel-cli.ts audit|snapshot|restore [--apply] [--limit=N] [--after=uid]");
  for (const flag of args.slice(1)) if (flag !== "--apply" && !/^--(limit|after)=.+$/.test(flag)) throw Error("Unknown option");
  const { db } = await import("../src/config/firebase.js");
  const report = await processLegacyUsers(db, { mode: mode as LegacyMode, apply: args.includes("--apply"), limit: Number(args.find(x=>x.startsWith("--limit="))?.slice(8) ?? 1000), after: args.find(x=>x.startsWith("--after="))?.slice(8) });
  console.log(JSON.stringify({ mode, dryRun: !args.includes("--apply"), ...report }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
