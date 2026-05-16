let unclosed = "The user is asking... \n\n### Creative";
const heuristicRegex = /\n\n(?=### |## |# |\*\*|- |\* |\d+\. |Here |I have |Sure)/i;
const heuristicMatch = unclosed.match(heuristicRegex);

console.log("Index:", heuristicMatch.index);
let thoughtText = unclosed.substring(0, heuristicMatch.index).trim();
console.log("ThoughtText:", thoughtText);
console.log("ThoughtText length:", thoughtText.length);
