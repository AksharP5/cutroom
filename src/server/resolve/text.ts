/** The Unicode flag treats a valid surrogate pair as one character. */
export const wellFormed = (text: string) =>
  text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");

/** Notes and instructions can include project text without letting it create new lines. */
export const oneLine = (text: string) =>
  wellFormed(text)
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
