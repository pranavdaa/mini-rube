/**
 * Query vocabulary tables.
 *
 * These are re-authored for the live googlesuper + github catalogs. The
 * pre-work's tables were keyed to separate gmail/googlecalendar/googledrive/
 * slack/notion toolkits; `googlesuper` merges every Google app under one slug,
 * so toolkit affinity alone can no longer tell "check my inbox" from "make a
 * spreadsheet". FACETS restore that distinction inside a toolkit.
 */

export const STOPWORDS = new Set(
  ("a an the to for of in on at by is it as be are was my me and or with from into about " +
    "that this all when then them their our your one do make please can you i we us using via " +
    "if after every each up out some any there here what which who how new latest s " +
    "item items thing things stuff info information detail details data")
    .split(" ")
);

/**
 * User vocabulary -> catalog vocabulary.
 *
 * Expansions are guesses, so the scorer caps their IDF credit (see lexical.ts).
 * Deliberately conservative: an expansion that drags in an unrelated action verb
 * (email -> send) would make "read my emails" rank SEND_EMAIL, so action verbs
 * are only expanded from words that genuinely imply that action.
 */
export const SYNONYMS: Record<string, string[]> = {
  // --- gmail -------------------------------------------------------------
  email: ["mail", "gmail", "message"],
  mail: ["email", "gmail", "message"],
  inbox: ["email", "mail", "gmail", "message", "thread"],
  message: ["email", "mail", "thread"],
  urgent: ["important", "unread", "starred", "priority"],
  unread: ["important", "starred"],
  attachment: ["attach", "file", "media"],
  pdf: ["attachment", "file", "document"],
  reply: ["respond", "thread"],
  draft: ["compose"],

  // --- calendar ----------------------------------------------------------
  meeting: ["event", "calendar"],
  meet: ["event", "calendar"],
  appointment: ["event", "calendar"],
  schedule: ["event", "calendar"],
  invite: ["event", "attendee"],
  availability: ["freebusy", "free", "slot", "calendar"],
  reschedule: ["update", "event"],

  // --- contacts ----------------------------------------------------------
  contact: ["people", "person", "contacts"],
  contacts: ["people", "person"],
  person: ["people", "contact"],
  someone: ["people", "contact"],

  // --- drive -------------------------------------------------------------
  drive: ["file", "folder"],
  folder: ["drive", "file", "parent"],
  resume: ["file", "document", "pdf"],
  resumes: ["file", "document", "pdf"],
  cv: ["resume", "file", "document"],
  doc: ["document", "file"],
  docs: ["document", "file"],
  download: ["get", "export", "file"],

  // --- sheets ------------------------------------------------------------
  sheet: ["spreadsheet", "worksheet"],
  spreadsheet: ["sheet", "worksheet"],
  row: ["record", "values"],
  column: ["values"],
  export: ["create", "write", "spreadsheet"],
  tabulate: ["spreadsheet", "sheet", "row"],

  // --- github ------------------------------------------------------------
  repo: ["repository", "repos"],
  repos: ["repository", "repo"],
  repository: ["repo", "repos"],
  issue: ["issues", "bug", "ticket"],
  issues: ["issue", "bug", "ticket"],
  bug: ["issue", "problem"],
  ticket: ["issue"],
  problem: ["issue", "bug"],
  pr: ["pull", "request"],
  prs: ["pull", "request"],
  commit: ["commits", "git"],
  branch: ["ref", "git"],

  // --- generic actions ---------------------------------------------------
  read: ["fetch", "list", "get"],
  find: ["search", "list", "get"],
  check: ["fetch", "list", "get"],
  show: ["fetch", "list", "get"],
  lookup: ["search", "get"],
  summarize: ["fetch", "list"],
  send: ["create"],
};

/** Verbs that signal the user wants an action performed; matched against slugs. */
export const ACTION_VERBS = new Set(
  ("send create fetch list update delete search get add schedule draft reply merge upload " +
    "share assign post query append find cancel publish close download export import move copy " +
    "read check show attach")
    .split(" ")
);

/** Verbs implying the user wants to read state. */
export const READ_VERBS = new Set(
  ("get fetch list read check find search show view lookup summarize review analyze " +
    "download export report")
    .split(" ")
);

/** Verbs implying the user wants to change state. */
export const WRITE_VERBS = new Set(
  ("send create update delete add post reply draft schedule merge upload share assign " +
    "cancel publish close append modify remove set move label attach import insert write make")
    .split(" ")
);

/** Slug verbs used to infer aspect when the provider gives no read/write hint. */
export const READ_SLUG_VERBS = ["GET", "FETCH", "LIST", "SEARCH", "QUERY", "FIND", "CHECK", "RETRIEVE"];

/**
 * Sub-app facets.
 *
 * `hints` are words a user types; `markers` are tokens that appear in the real
 * slugs/tags of tools in that facet. A facet matches a tool when any marker is
 * present in its slug tokens or tags.
 *
 * Facets are additive metadata over the live catalog, not a hardcoded tool list:
 * a new toolkit works without facets (falling back to toolkit-level affinity),
 * and gains sub-routing by adding an entry here.
 */
export interface Facet {
  id: string;
  toolkit: string;
  hints: string[];
  markers: string[];
}

export const FACETS: Facet[] = [
  {
    id: "gmail",
    toolkit: "googlesuper",
    hints: ["email", "emails", "mail", "inbox", "gmail", "message", "messages", "unread", "draft", "attachment", "reply", "urgent", "newsletter"],
    markers: ["email", "emails", "mail", "gmail", "message", "messages", "thread", "draft", "label", "attachment", "mailbox", "send"],
  },
  {
    id: "calendar",
    toolkit: "googlesuper",
    hints: ["calendar", "event", "events", "meeting", "meetings", "schedule", "invite", "appointment", "availability", "slot", "slots", "reschedule"],
    markers: ["event", "events", "calendar", "calendars", "freebusy", "attendee", "recurrence"],
  },
  {
    id: "contacts",
    toolkit: "googlesuper",
    hints: ["contact", "contacts", "person", "people", "someone", "attendee", "colleague"],
    markers: ["contact", "contacts", "people", "person", "directory"],
  },
  {
    id: "drive",
    toolkit: "googlesuper",
    hints: ["drive", "folder", "folders", "file", "files", "resume", "resumes", "cv", "upload", "download", "pdf", "attachment"],
    markers: ["file", "files", "folder", "drive", "teamdrive", "download", "upload", "permission", "parent"],
  },
  {
    id: "sheets",
    toolkit: "googlesuper",
    hints: ["sheet", "sheets", "spreadsheet", "spreadsheets", "row", "rows", "column", "columns", "cell", "csv", "table", "export", "tabulate"],
    markers: ["sheet", "sheets", "spreadsheet", "spreadsheets", "row", "column", "cell", "values", "worksheet"],
  },
  {
    id: "docs",
    toolkit: "googlesuper",
    hints: ["doc", "docs", "document", "documents"],
    markers: ["doc", "docs", "document", "documents", "googledocs"],
  },
  {
    id: "issues",
    toolkit: "github",
    hints: ["issue", "issues", "bug", "bugs", "ticket", "tickets", "problem", "problems", "report", "reports"],
    markers: ["issue", "issues", "label", "milestone", "comment"],
  },
  {
    id: "pulls",
    toolkit: "github",
    hints: ["pr", "prs", "pull", "review", "merge", "merged", "diff"],
    markers: ["pull", "pulls", "review", "merge", "commit"],
  },
  {
    id: "repos",
    toolkit: "github",
    hints: ["repo", "repos", "repository", "repositories", "branch", "commit", "commits", "fork", "readme"],
    markers: ["repo", "repos", "repository", "repositories", "branch", "commit", "commits", "fork", "contents"],
  },
  {
    id: "actions",
    toolkit: "github",
    hints: ["workflow", "workflows", "action", "actions", "ci", "build", "pipeline", "run", "runs"],
    markers: ["workflow", "workflows", "actions", "run", "runs", "job", "jobs", "artifact"],
  },
];
