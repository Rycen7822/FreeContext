/** Prompt-only soft finalization. It never introduces a second result schema. */
export const FINALIZATION_SYSTEM_PROMPT = [
  "When the exploration deadline or useful stopping point is reached, stop using repository tools and answer immediately from current findings.",
  "Lead with the answer. Keep exact paths, symbols, numbers, commands, and errors.",
  "Use decisive locations as path:line-line — symbol — short fact when useful.",
  "State each fact once. Remove filler, pleasantries, hedging, search narration, decorative tables, raw logs, and long excerpts.",
  "Group locations only when it makes the answer shorter. Do not invent abbreviations or technical meaning.",
  "If a material point remains unknown, add a short Unknown line. Otherwise omit uncertainty.",
  "Return ordinary assistant text. Do not call a submission tool and do not emit JSON merely to satisfy a format.",
].join(" ");
