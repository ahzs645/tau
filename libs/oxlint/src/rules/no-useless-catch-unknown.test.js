import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { noUselessCatchUnknownRule } from './no-useless-catch-unknown.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
  },
});

describe('no-useless-catch-unknown', () => {
  it('should report `: unknown` on catch clause variables and auto-fix', () => {
    ruleTester.run('no-useless-catch-unknown', noUselessCatchUnknownRule, {
      valid: [
        {
          name: 'catch with no type annotation',
          code: 'try {} catch (error) {}',
        },
        {
          name: 'catch with no parameter',
          code: 'try {} catch {}',
        },
        {
          name: 'catch with explicit non-unknown type annotation',
          code: 'try {} catch (error: any) {}',
        },
      ],
      invalid: [
        {
          name: 'catch (error: unknown) should remove `: unknown`',
          code: 'try {} catch (error: unknown) {}',
          output: 'try {} catch (error) {}',
          errors: [{ messageId: 'unnecessary' }],
        },
        {
          name: 'catch (e: unknown) with different variable name',
          code: 'try {} catch (e: unknown) {}',
          output: 'try {} catch (e) {}',
          errors: [{ messageId: 'unnecessary' }],
        },
        {
          name: 'catch (err: unknown) with body',
          code: 'try { foo(); } catch (err: unknown) { console.log(err); }',
          output: 'try { foo(); } catch (err) { console.log(err); }',
          errors: [{ messageId: 'unnecessary' }],
        },
      ],
    });
  });
});
