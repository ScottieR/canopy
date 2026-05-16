const msg = { text: "[THOUGHT_PROCESS]This is a thought[/THOUGHT_PROCESS]\n\nHello" };
let text = msg.text.replace(/<think>/gi, "[THOUGHT_PROCESS]").replace(/<\/think>/gi, "[/THOUGHT_PROCESS]");

text = text.replace(/(?:System:\s*)?\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\]\s*(?:[^:\n]+:\s*)?/gi, "");
text = text.replace(/(?:System:\s*)?\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\][^\.\n]+\.\s*/gi, "");
text = text.replace(/\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\]\s*/gi, "");

console.log(text);
