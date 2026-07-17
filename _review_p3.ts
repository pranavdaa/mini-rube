import { selectTools } from "./src/lib/router/select";
const P = "read all the issues (open and closed) on composiohq/composio and make a google sheet with the problems people are reporting";
for (let i = 0; i < 3; i++) {
  const s = await selectTools({ text: P, attachments: [], context: [] });
  if (i === 0) {
    console.log("stage-1 candidates:");
    for (const c of s.candidates) console.log(`  ${c.score.toFixed(1).padStart(7)}  ${c.slug}`);
  }
  console.log(`run ${i + 1}: stage2=${s.confirm.source} cached=${s.confirm.cached} → [${s.selected.map((c) => c.slug).join(", ")}]`);
}
process.exit(0);
