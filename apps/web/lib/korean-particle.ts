// Korean particles that follow the last sound of a word. A fixed "(으)로" in a
// sentence reads as a form field left unfilled; these pick the right one.

function lastSyllable(word: string): string {
  const text = word.trim().replace(/[\s"'‘’“”)\].,!?:;·]+$/u, "");
  return text.slice(-1);
}

// 0 = no final consonant (or not Hangul), 8 = ㄹ, anything else = a final consonant.
function finalIndex(word: string): number {
  const code = lastSyllable(word).charCodeAt(0);
  if (!(code >= 0xac00 && code <= 0xd7a3)) return 0;
  return (code - 0xac00) % 28;
}

/** "로" after a vowel or ㄹ, "으로" after any other final consonant. */
export function roParticle(word: string): "로" | "으로" {
  const index = finalIndex(word);
  return index === 0 || index === 8 ? "로" : "으로";
}

/** "를" after a vowel, "을" after a final consonant. */
export function eulParticle(word: string): "를" | "을" {
  return finalIndex(word) === 0 ? "를" : "을";
}
