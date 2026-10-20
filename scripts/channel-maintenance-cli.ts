/** Operator-only recovery; no scheduled worker and no writes unless --apply is explicit. */
async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (mode !== "purge" && mode !== "expired-invites") {
    throw Error("Usage: channel-maintenance-cli.ts purge <accountId>|expired-invites [--limit=N] [--after=token] [--apply]");
  }
  const accountId = mode === "purge" ? args.shift() : undefined;
  if (mode === "purge" && (!accountId || accountId.startsWith("--"))) throw Error("purge requires a channel id");
  for (const arg of args) {
    if (arg !== "--apply" && !/^--limit=\d+$/.test(arg) && !(mode === "expired-invites" && /^--after=[A-Za-z0-9_-]{43}$/.test(arg))) {
      throw Error("Unknown or invalid maintenance option");
    }
  }
  const dryRun = !args.includes("--apply");
  const limit = Number(args.find(arg => arg.startsWith("--limit="))?.slice(8) ?? (mode === "purge" ? 2000 : 200));
  if (!Number.isInteger(limit) || limit < 1 || limit > (mode === "purge" ? 2000 : 450)) throw Error("Maintenance limit is out of range");
  if (mode === "purge") {
    const { default: AccountRepository } = await import("../src/repository/account.repository.js");
    const result = await new AccountRepository().purgeAccountData(accountId!, limit, dryRun);
    console.log(JSON.stringify({ mode, accountId, dryRun, ...result }));
  } else {
    const { default: SharingRepository } = await import("../src/repository/sharing.repository.js");
    const after = args.find(arg => arg.startsWith("--after="))?.slice(8);
    const result = await new SharingRepository().pruneExpired(limit, after, dryRun);
    console.log(JSON.stringify({ mode, dryRun, ...result }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
