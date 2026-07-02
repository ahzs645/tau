/**
 * Convert a string from camelCase or snake_case to Sentence Case. Acronyms are preserved.
 *
 * @example <caption>camelCase input</caption>
 * toTitleCase('firstName'); // 'First Name'
 *
 * @example <caption>snake_case input</caption>
 * toTitleCase('first_name'); // 'First Name'
 *
 * @example <caption>Acronyms are preserved</caption>
 * toTitleCase('HTML'); // 'HTML'
 *
 * @example <caption>Digits are separated from letters</caption>
 * toTitleCase('test123Name'); // 'Test 123 Name'
 *
 * @param string_ The camelCase or snake_case string to convert
 * @returns The converted Title Case string
 */
export const toTitleCase = (string_: string): string => {
  return (
    string_
      // Convert snake_case and kebab-case separators to spaces
      .replaceAll(/[_-]/g, ' ')
      // Add space before uppercase letters when preceded by lowercase letters or digits
      .replaceAll(/(?<=[\da-z])([A-Z])/g, ' $1')
      // Add space between letters and digits (e.g., 'test123' -> 'test 123')
      .replaceAll(/(?<=[A-Za-z])(\d)/g, ' $1')
      // Add space between digits and letters (e.g., '123test' -> '123 test')
      .replaceAll(/(?<=\d)([A-Za-z])/g, ' $1')
      // Add space after special characters when followed by alphanumeric
      .replaceAll(/([^\s\w])([\dA-Za-z])/g, '$1 $2')
      // Remove extra spaces
      .replaceAll(/\s+/g, ' ')
      .trim()
      // Capitalize the first letter of each word
      .replaceAll(/\b\w/g, (char) => char.toUpperCase())
  );
};
