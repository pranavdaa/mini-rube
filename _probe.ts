import { Composio } from "@composio/core";
const c = new Composio();
const HINTS = new Set(["important","openWorldHint","readOnlyHint","idempotentHint","updateHint","createHint","destructiveHint","deprecated"]);
for (const tk of ["googlesuper","github"]) {
  const r: any = await c.tools.getRawComposioTools({ toolkits: [tk], limit: 2000 } as any);
  const items: any[] = Array.isArray(r) ? r : (r.items ?? []);
  const freq = new Map<string, number>();
  for (const t of items) for (const tag of (t.tags ?? [])) if (!HINTS.has(tag)) freq.set(tag, (freq.get(tag) ?? 0) + 1);
  console.log(`\n=== ${tk}: ${items.length} tools | semantic tags (${freq.size} distinct):`);
  console.log([...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([k,v])=>`${k}(${v})`).join(" "));
  console.log(`  deprecated tools: ${items.filter(t=>t.isDeprecated).length}`);
}
// slug prefixes within googlesuper reveal sub-app grouping
const g: any = await c.tools.getRawComposioTools({ toolkits: ["googlesuper"], limit: 2000 } as any);
const gi: any[] = Array.isArray(g) ? g : (g.items ?? []);
console.log("\n=== googlesuper slugs matching key prompt vocabulary:");
for (const kw of ["EMAIL","CONTACT","PEOPLE","EVENT","CALENDAR","FILE","FOLDER","DRIVE","SHEET","SPREADSHEET"]) {
  const m = gi.map(t=>t.slug).filter((s:string)=>s.includes(kw));
  console.log(`  ${kw.padEnd(11)} ${m.length.toString().padStart(3)}  e.g. ${m.slice(0,4).join(", ")}`);
}
