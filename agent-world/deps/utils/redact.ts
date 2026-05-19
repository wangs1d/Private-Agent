const phonePattern = /\b1\d{10}\b/g;
const idPattern = /\b\d{17}[\dXx]\b/g;
const bankPattern = /\b\d{16,19}\b/g;

export function redactSensitiveText(input: string): string {
  return input
    .replace(phonePattern, "***PHONE***")
    .replace(idPattern, "***ID***")
    .replace(bankPattern, "***BANK***");
}
