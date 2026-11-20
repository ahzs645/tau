import assert from 'node:assert/strict';

type StepLexeme =
  | Readonly<{ kind: 'word'; value: string | undefined }>
  | Readonly<{ kind: 'id'; value: number }>
  | Readonly<{ kind: 'symbol'; value: string }>;

/** A bounded STEP token; strings and comments are separators, never entity syntax. @internal */
export type StepToken = StepLexeme & Readonly<{ separated: boolean }>;

type LexerState = 'code' | 'word' | 'id' | 'literal' | 'closed-literal' | 'slash' | 'star' | 'comment';
const wordCharacter = /^[\w-]$/u;
const digitCharacter = /^\d$/u;
const whitespace = /^\s$/u;
const malformedLiteral = 'STEP contains an unterminated string or comment';

/**
 * Scan bounded decoded chunks without retaining a whole record, quoted value or comment.
 * Only short identifiers are needed for structural checks; entity IDs are accumulated numerically.
 * @internal
 */
export const createStepLexer = (accept: (token: StepToken) => void): { write(text: string): void; finish(): void } => {
  let state: LexerState = 'code';
  let separated = false;
  let word: string | undefined;
  let id = 0;
  let hasIdDigits = false;
  let quote = "'";
  let commentStar = false;

  const emit = (token: StepLexeme): void => {
    accept({ ...token, separated });
    separated = false;
  };
  const emitId = (): void => {
    emit({ kind: 'id', value: hasIdDigits ? id : Number.NaN });
  };
  const codeCharacter = (character: string): void => {
    if (whitespace.test(character)) {
      separated = true;
      return;
    }
    switch (character) {
      case "'":
      case '"': {
        quote = character;
        separated = true;
        state = 'literal';
        break;
      }
      case '/': {
        state = 'slash';
        break;
      }
      case '*': {
        state = 'star';
        break;
      }
      case '#': {
        id = 0;
        hasIdDigits = false;
        state = 'id';
        break;
      }
      default: {
        if (wordCharacter.test(character)) {
          word = character;
          state = 'word';
        } else {
          emit({ kind: 'symbol', value: character });
        }
      }
    }
  };

  /** Return whether this character was consumed; a delimiter is processed again as code. */
  const pendingCharacter = (character: string): boolean => {
    switch (state) {
      case 'word': {
        if (wordCharacter.test(character)) {
          word = word !== undefined && word.length < 32 ? word + character : undefined;
          return true;
        }
        emit({ kind: 'word', value: word });
        break;
      }
      case 'id': {
        if (digitCharacter.test(character)) {
          id = id * 10 + Number(character);
          hasIdDigits = true;
          return true;
        }
        emitId();
        break;
      }
      case 'slash': {
        if (character === '*') {
          state = 'comment';
          commentStar = false;
          separated = true;
          return true;
        }
        emit({ kind: 'symbol', value: '/' });
        break;
      }
      case 'star': {
        assert.notEqual(character, '/', malformedLiteral);
        emit({ kind: 'symbol', value: '*' });
        break;
      }
      case 'closed-literal': {
        if (character === quote) {
          state = 'literal';
          return true;
        }
        break;
      }
      default: {
        throw new Error('Invalid STEP lexer state.');
      }
    }
    state = 'code';
    return false;
  };

  const skipComment = (text: string, start: number): number => {
    if (commentStar && text[start] === '/') {
      state = 'code';
      commentStar = false;
      return start + 1;
    }
    const end = text.indexOf('*/', start);
    if (end === -1) {
      commentStar = text.endsWith('*');
      return text.length;
    }
    state = 'code';
    commentStar = false;
    return end + 2;
  };
  const skipLiteral = (text: string, start: number): number => {
    const end = text.indexOf(quote, start);
    if (end === -1) {
      return text.length;
    }
    state = 'closed-literal';
    return end + 1;
  };

  return {
    write(text: string): void {
      let index = 0;
      while (index < text.length) {
        if (state === 'comment') {
          index = skipComment(text, index);
        } else if (state === 'literal') {
          index = skipLiteral(text, index);
        } else {
          const character = text[index]!;
          if (state === 'code') {
            codeCharacter(character);
            index += 1;
          } else if (pendingCharacter(character)) {
            index += 1;
          }
        }
      }
    },
    finish(): void {
      assert.ok(state !== 'literal' && state !== 'comment', malformedLiteral);
      switch (state) {
        case 'word': {
          emit({ kind: 'word', value: word });
          break;
        }
        case 'id': {
          emitId();
          break;
        }
        case 'slash':
        case 'star': {
          emit({ kind: 'symbol', value: state === 'slash' ? '/' : '*' });
          break;
        }
        default: {
          break;
        }
      }
      state = 'code';
    },
  };
};
