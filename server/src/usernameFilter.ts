// Milestone 166: basic username appropriateness filter, by direct request (grades 5-9,
// self-registered accounts, no moderator in the loop before a name goes live). Not bulletproof -
// a determined student will find a bypass - but catches lazy/obvious cases and common leetspeak
// substitutions. Blocklist entries are chosen to avoid colliding with common innocent words
// (e.g. "ass"/"sex"/"kill" are deliberately left out - they're substrings of "class"/"unisex"/
// "skill" and would false-positive constantly; "asshole"/"faggot"/etc are used whole instead).
const LEETSPEAK: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i",
};

const BLOCKED_WORDS = [
  "fuck", "shit", "bitch", "bastard", "asshole", "dick", "pussy", "cunt", "cock", "whore", "slut",
  "nigger", "nigga", "faggot", "fag", "retard", "hitler", "nazi", "porn", "penis", "vagina",
];

function normalize(raw: string): string {
  const lower = raw.toLowerCase();
  const delee = lower.split("").map((ch) => LEETSPEAK[ch] ?? ch).join("");
  return delee.replace(/[^a-z]/g, "");
}

export function isUsernameAllowed(raw: string): boolean {
  const norm = normalize(raw);
  return !BLOCKED_WORDS.some((word) => norm.includes(word));
}
