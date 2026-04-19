// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
// oxlint-disable-next-line @typescript-eslint/ban-ts-comment -- TODO: fix these types
// @ts-nocheck

export type ParsedFunctionoidDefinition = {
  path: string;
  name: string;
  params?: Array<{
    name: string;
    defaultValue: string;
  }>;
  signature: string;
  referencesChildren: boolean | undefined;
};
export type ParsedFunctionoidDefinitions = Record<string, ParsedFunctionoidDefinition>;

export type ParsedFile = {
  functions: ParsedFunctionoidDefinitions;
  modules: ParsedFunctionoidDefinitions;
  vars: string[];
  includes: string[];
  uses: string[];
};

export const stripComments = (source: string): string => source.replaceAll(/\/\*(.|[\S\s])*?\*\/|\/\/.*?$/gm, '');

export function parseOpenScad(path: string, source: string, skipPrivates: boolean): ParsedFile {
  const withoutComments = stripComments(source);
  const variables = [];
  const functions: ParsedFunctionoidDefinitions = {};
  const modules: ParsedFunctionoidDefinitions = {};
  const includes: string[] = [];
  const uses: string[] = [];
  for (const m of withoutComments.matchAll(/(use|include)\s*<([^>]+)>/g)) {
    (m[1] === 'use' ? uses : includes).push(m[2]);
  }

  for (const m of withoutComments.matchAll(/(?:^|[;{}])\s*([\w$]+)\s*=/g)) {
    variables.push(m[1]);
  }

  for (const m of withoutComments.matchAll(
    /(function|module)\s+([\w$]+)\s*\(([^)]*)\)(?:\s*(?:=\s*)?({}|[^{}]+?;))?/gm,
  )) {
    const type = m[1];
    const name = m[2];
    if (skipPrivates && name.startsWith('_')) {
      continue;
    }

    const parametersString = m[3];
    const optBody = m[4];
    const parameters = [];
    if (/^(\s*([\w$]+(\s*=[^(),[]+)?(\s*,\s*[\w$]+(\s*=[^(),[]+)?)*)?\s*)$/m.test(parametersString)) {
      for (const parameterString of parametersString.split(',')) {
        const am = /^\s*([\w$]+)(?:\s*=([^(),[]+))?\s*$/.exec(parameterString);
        if (am) {
          const parameterName = am[1];
          const defaultValue = am[2];
          parameters.push({
            name: parameterName,
            defaultValue,
          });
        }
      }
    }

    (type === 'function' ? functions : modules)[name] = {
      path,
      name,
      signature: `${name}(${parametersString.replaceAll(/\s+/gm, ' ').replaceAll(/\b | \b/g, '')})`,
      params: parameters,
      referencesChildren: optBody === undefined ? undefined : optBody.includes('children()'),
    };
  }

  return { vars: variables, functions, modules, includes, uses };
}
