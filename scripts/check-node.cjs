const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`Node 22 or newer is required. You are running ${process.version}.`);
  process.exit(1);
}
if (![22, 24, 26].includes(major)) {
  console.warn(`Node ${major} is not in the tested runtime matrix (22, 24, 26). Run npm run test:runtime and npm test before using it.`);
}
