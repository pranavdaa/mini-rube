import { selectTools } from "./src/lib/router/select";
const PROMPTS = [
  "read my last 100 emails and show me the important ones",
  "schedule a calendar event tomorrow with karan (don't give his full email)",
  "read all the issues (open and closed) on composiohq/composio and make a google sheet with the problems people are reporting",
  "can you take all the resumes in this drive and make a google sheet with candidates names, uni and last job https://drive.google.com/drive/folders/1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r?usp=sharing",
  "send an email with the attached pdf",
  // review's variations
  "find emails that require action",
  "invite karan to a meeting tomorrow",
  "export repository complaints to a spreadsheet",
  "analyze every CV in this folder https://drive.google.com/drive/folders/1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r",
  "email this document as an attachment",
  "show emails requiring action",
];
for (const p of PROMPTS) {
  const s = await selectTools({ text: p, attachments: p.includes("attach") ? [{ name: "x.pdf", contentType: "application/pdf" }] : [], context: [] });
  console.log(`\n>>> "${p.slice(0, 70)}"`);
  console.log(`    stage2=${s.confirm.source} selected=[${s.selected.map((c) => c.slug).join(", ")}]`);
}
process.exit(0);
