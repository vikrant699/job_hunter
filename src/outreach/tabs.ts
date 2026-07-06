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
