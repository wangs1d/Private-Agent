const phonePattern = /\b1\d{10}\b/g;
const idPattern = /\b\d{17}[\dXx]\b/g;
const bankPattern = /\b\d{16,19}\b/g;
const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const ipPattern = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

export function redactSensitiveText(input: string): string {
  return input
    .replace(emailPattern, "***EMAIL***")
    .replace(ipPattern, "***IP***")
    .replace(phonePattern, "***PHONE***")
    .replace(idPattern, "***ID***")
    .replace(bankPattern, "***BANK***");
}
