/**
 * Header contracts for the bot-managed outreach tabs. Shared by the bootstrap
 * script (writes headers into empty tabs) and sheet-sync (rewrites Drafts/Sent
 * with the same headers every run) so the two can never drift.
 */
export const RAW_DATA_HEADER = ["company", "email", "contact_name", "alt_names", "flags", "seen"] as const;

export const DRAFTS_HEADER = [
  "Run Date", "Profile", "Company", "Roles", "Severity", "Score",
  "Recruiter Email", "Drafted At", "Gmail Draft Id",
] as const;

export const SENT_HEADER = [
  "Run Date", "Profile", "Company", "Roles", "Recruiter Email",
  "Sent At", "Check After", "Status", "Last Checked",
] as const;

export const UNDRAFTED_HEADER = [
  "Run Date", "Profile", "Company", "Role", "Location", "Job URL",
  "Severity", "Score", "Reason",
] as const;

/** Columns the bot appends to the manually-maintained Recruiters List tab (E:G). */
export const RECRUITERS_EXTRA_HEADER = ["Source", "Verified On", "Registry Slug"] as const;

/** Manually-maintained Recruiters List tab layout (columns A-D are human-owned;
 *  E-G are the bot's RECRUITERS_EXTRA_HEADER). Kept here so contacts.ts (reader)
 *  and verify.ts (promoter) can never disagree on which column is which. */
export const RECRUITERS_LIST_COLS = { company: 0, name: 1, phone: 2, email: 3 } as const;

/** Must agree with RAW_DATA_HEADER's column order (company, email, contact_name, alt_names, ...). */
export const RAW_DATA_COLS = { company: 0, email: 1, contactName: 2, altNames: 3 } as const;
